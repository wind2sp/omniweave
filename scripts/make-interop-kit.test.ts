// Interop test kit: files SAVED BY OMNIWEAVE for black-box checks in the real programs
// (Photoshop · Illustrator · Acrobat Pro · 한글 · Word · Excel · PowerPoint) on another PC.
//
//   regenerate the committed kit:   OMW_INTEROP_KIT=1 npx vitest run scripts/make-interop-kit.test.ts --dir scripts
//                         (PowerShell: $env:OMW_INTEROP_KIT=1; npx vitest run scripts/make-interop-kit.test.ts --dir scripts)
//
// With OMW_INTEROP_KIT=1 it writes qa/interop/omniweave-made/* (+ expected.json) and qa/interop/CHECKLIST.md.
// Without it (a plain `npx vitest run`) the same files are generated and self-checked in a temporary folder
// that is removed afterwards: tests that read the committed kit (tests/size/*) never see it half-written.
// Only the app's own import/export code is used (registry exports, PSD writer, vector PDF export,
// PDF Surgeon, Office encryption). All content is synthetic test content generated here — no
// personal files (test-corpus/) are read. Every file is re-opened with Omniweave's own readers and
// compared with the values this generator put in (self check); mismatches fail the run AND are
// recorded in expected.json ("selfCheck") so the kit still documents them.
// Test password: omw-test-1234 (test only).

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { unzipSync } from "fflate";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { makeAsset } from "../src/core/assets";
import { makeTile } from "../src/core/loom";
import { toggleList } from "../src/core/richtext";
import { newDocument, newImage, newPage, newParagraph, newTable, newText, newVector, TILE, type BlendMode, type OmwDocument, type Page, type RasterNode, type SceneNode, type TableCell, type TextNode, type TextParagraph, type TextRun, type VectorNode } from "../src/core/types";
import { ellipseContour, rectContour } from "../src/core/vector";
import { decryptOffice, encryptOffice, isEncryptedOffice } from "../src/io/crypto/office";
import { encryptPdf } from "../src/io/crypto/pdfEncrypt";
import { exportById, formatForExt, type ExportCtx, type Opened } from "../src/io/formats";
import { importCsv } from "../src/io/formats/csv";
import { encodePng } from "../src/io/formats/png";
import { decodePsd, parsePsdLayout } from "../src/io/formats/psd";
import { buildPsd, writePsd, type FreshLayer } from "../src/io/formats/psdWrite";
import { rasterFromRgba } from "../src/io/formats/raster";
import { encodeText } from "../src/io/formats/textcodec";
import { paginate, wordLine } from "../src/io/office";
import { elevatePage, openSurgeonDoc, saveSurgical, type SurgeonDoc } from "../src/io/pdfsurgeon";
import { setCMapLoader } from "../src/io/pdfsurgeon/bcmap";
import { exportPdfVector } from "../src/io/pdfVector";

// ───────── environment (Node builtins loaded untyped: the project has no @types/node) ─────────

interface Fs {
  writeFileSync(p: string, d: Uint8Array | string): void;
  readFileSync(p: string): Uint8Array;
  mkdirSync(p: string, o: { recursive: boolean }): void;
  existsSync(p: string): boolean;
  rmSync(p: string, o: { recursive: boolean; force: boolean }): void;
}
let fs: Fs;
let pdfjs: any;
let FONT_REG: Uint8Array;
let FONT_BOLD: Uint8Array;
/** OMW_INTEROP_KIT=1: write the committed kit; else a temporary folder (set in beforeAll) */
const REGENERATE = (globalThis as any).process?.env?.OMW_INTEROP_KIT === "1";
let ROOT = "qa/interop";
let OUT = `${ROOT}/omniweave-made`;
let SRC = `${OUT}/_source`;
const PW = "omw-test-1234";
const CTX: ExportCtx = { confirm: () => true };
const MB = 1024 * 1024;

vi.setConfig({ testTimeout: 300_000, hookTimeout: 120_000 });

beforeAll(async () => {
  (globalThis as any).DOMParser = DOMParser;
  const nodeFs = "node:fs", nodeUrl = "node:url";
  fs = (await import(/* @vite-ignore */ nodeFs)) as Fs;
  const url = (await import(/* @vite-ignore */ nodeUrl)) as { pathToFileURL(p: string): { href: string } };
  const cwd: string = (globalThis as any).process.cwd();
  pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = url.pathToFileURL(cwd + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
  setCMapLoader(async (name) => {
    const p = `${cwd}/node_modules/pdfjs-dist/cmaps/${name}.bcmap`;
    return fs.existsSync(p) ? new Uint8Array(fs.readFileSync(p)) : null;
  });
  FONT_REG = new Uint8Array(fs.readFileSync("assets/fonts/Pretendard-Regular.ttf"));
  FONT_BOLD = new Uint8Array(fs.readFileSync("assets/fonts/Pretendard-Bold.ttf"));
  if (!REGENERATE) {
    const os = (await import(/* @vite-ignore */ "node:os")) as { tmpdir(): string };
    ROOT = `${os.tmpdir()}/omw-interop-kit-${(globalThis as any).process.pid}-${Date.now().toString(36)}`;
    OUT = `${ROOT}/omniweave-made`;
    SRC = `${OUT}/_source`;
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(SRC, { recursive: true });
});

afterAll(() => {
  if (!REGENERATE && fs) fs.rmSync(ROOT, { recursive: true, force: true });
});

// ───────── kit registry: what each file is, how to check it, and what it must contain ─────────

interface Entry {
  file: string;
  programs: string[];
  /** what kind of save produced the file (shown in the checklist) */
  nature: string;
  password?: string;
  /** reference input (not an Omniweave save) in _source/ */
  source?: string;
  checks: string[];
  expected: Record<string, unknown>;
  bytes?: number;
}
const KIT: Entry[] = [];
const SELF: Record<string, { what: string; ok: boolean; actual?: unknown; want?: unknown }[]> = {};
const DEFECTS: string[] = [];

function save(name: string, bytes: Uint8Array, dir = OUT) {
  fs.writeFileSync(`${dir}/${name}`, bytes);
  expect(bytes.length, `${name} ≤ 5MB`).toBeLessThanOrEqual(5 * MB);
  return bytes;
}
function add(e: Entry, bytes: Uint8Array) {
  e.bytes = bytes.length;
  KIT.push(e);
  save(e.file, bytes);
}
/** Self check: records the result for expected.json and fails the run (softly) on mismatch. */
function check(file: string, what: string, actual: unknown, want: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  (SELF[file] ??= []).push(ok ? { what, ok } : { what, ok, actual, want });
  expect.soft(actual, `${file}: ${what}`).toEqual(want);
}
function checkTrue(file: string, what: string, cond: boolean, detail?: unknown) {
  (SELF[file] ??= []).push(cond ? { what, ok: true } : { what, ok: false, actual: detail ?? false, want: true });
  expect.soft(cond, `${file}: ${what}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ""}`).toBe(true);
}
/**
 * A mismatch already diagnosed as an Omniweave defect (reported to the main team): recorded as a failed
 * self check and in generatorDefects, but does not fail the run. Once fixed, it FAILS the run so the
 * marker gets removed.
 */
function knownDefect(file: string, what: string, actual: unknown, want: unknown, defect: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(want);
  (SELF[file] ??= []).push(ok ? { what, ok } : { what, ok, actual, want });
  if (!ok) DEFECTS.push(`${file}: ${defect}`);
  expect.soft(ok, `${file}: ${what} — 고쳐졌으면 knownDefect 표시를 check()로 바꾸세요`).toBe(false);
}
const r2 = (n: number) => Math.round(n * 100) / 100;
const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

async function openVia(ext: string, name: string, bytes: Uint8Array): Promise<Opened> {
  return formatForExt(ext)!.open!({ name, path: null, bytes }, { confirm: () => true });
}
async function exportVia(id: string, doc: OmwDocument, page: Page): Promise<Uint8Array> {
  const out = await exportById(id)!.run(doc, page, CTX);
  return typeof out === "string" ? new TextEncoder().encode(out) : out;
}

// ───────── pdf.js helpers ─────────

async function openJs(bytes: Uint8Array, password?: string) {
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, password }).promise;
}
async function pdfTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
  const d = await openJs(bytes, password);
  const out: string[] = [];
  for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(""));
  await d.destroy();
  return out;
}
async function pdfSizes(bytes: Uint8Array, password?: string): Promise<[number, number][]> {
  const d = await openJs(bytes, password);
  const out: [number, number][] = [];
  for (let i = 1; i <= d.numPages; i++) {
    const vp = (await d.getPage(i)).getViewport({ scale: 1 });
    out.push([r2(vp.width), r2(vp.height)]);
  }
  await d.destroy();
  return out;
}
const squash = (s: string) => s.replace(/\s+/g, "");

// ───────── pixels ─────────

type RGBA = [number, number, number, number];
function rgbaImage(w: number, h: number, fn: (x: number, y: number) => RGBA | null): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = fn(x, y);
      if (c) out.set(c, (y * w + x) * 4);
    }
  return out;
}
const solid = (c: RGBA) => () => c;
const disc = (d: number, c: RGBA) => (x: number, y: number) => (Math.hypot(x + 0.5 - d / 2, y + 0.5 - d / 2) <= d / 2 ? c : null);
const triangle = (w: number, h: number, c: RGBA) => (x: number, y: number) => (Math.abs(x + 0.5 - w / 2) <= ((y + 0.5) / h) * (w / 2) ? c : null);
const checker = (s: number, a: RGBA, b: RGBA) => (x: number, y: number) => ((Math.floor(x / s) + Math.floor(y / s)) % 2 ? a : b);
const gradient = (w: number, h: number) => (x: number, y: number): RGBA => [Math.round((x / w) * 200) + 30, Math.round((y / h) * 180) + 40, 200, 255];

/** Non-transparent bounding box [left, top, right, bottom] in page coordinates (Photoshop's layer bounds). */
function bounds(rgba: Uint8Array, w: number, h: number, left: number, top: number): [number, number, number, number] {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return [left + x0, top + y0, left + x1 + 1, top + y1 + 1];
}

function pngOf(w: number, h: number, fn: (x: number, y: number) => RGBA | null) {
  return encodePng(rgbaImage(w, h, fn), w, h);
}

/** Paint a rectangle into a raster node's first tile (local coordinates, inside 256px). */
function paintRect(n: RasterNode, x0: number, y0: number, w: number, h: number, c: RGBA): RasterNode {
  const key = "0_0";
  const data = new Uint8ClampedArray(n.tiles[key]?.data ?? new Uint8ClampedArray(TILE * TILE * 4));
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set(c, (y * TILE + x) * 4);
  return { ...n, tiles: { ...n.tiles, [key]: makeTile(data) } };
}

// ═════════════════════════════ PSD ═════════════════════════════

const PSD_BLEND: Record<BlendMode, string> = { NORMAL: "norm", MULTIPLY: "mul ", SCREEN: "scrn", OVERLAY: "over", HARD_LIGHT: "hLit" };
const PS_BLEND_UI: Record<string, string> = { norm: "표준(Normal)", "mul ": "곱하기(Multiply)", scrn: "스크린(Screen)", over: "오버레이(Overlay)", hLit: "하드 라이트(Hard Light)" };

interface LayerSpec {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fn: (x: number, y: number) => RGBA | null;
  blend: BlendMode;
  opacityPct: number;
  visible: boolean;
  locked?: boolean;
}
function layerExpect(l: LayerSpec, rgba: Uint8Array) {
  return { name: l.name, blend: PSD_BLEND[l.blend], blendUI: PS_BLEND_UI[PSD_BLEND[l.blend]], opacityPct: l.opacityPct, visible: l.visible, locked: !!l.locked, bounds: bounds(rgba, l.w, l.h, l.x, l.y) };
}
const rawBlock = (key: string, data: number[]) => {
  const d = new Uint8Array(12 + data.length + (data.length % 2));
  d.set(new TextEncoder().encode("8BIM"), 0);
  d.set(new TextEncoder().encode(key), 4);
  new DataView(d.buffer).setUint32(8, data.length + (data.length % 2));
  d.set(data, 12);
  return d;
};
/** Section divider block (lsct): 1 open folder, 2 closed folder, 3 bounding divider. */
const lsct = (t: number) => rawBlock("lsct", [0, 0, 0, t]);
const freshLayer = (l: LayerSpec): FreshLayer => ({ name: l.name, px: { rgba: rgbaImage(l.w, l.h, l.fn), left: l.x, top: l.y, width: l.w, height: l.h }, opacity: l.opacityPct / 100, visible: l.visible, blend: l.blend, locked: l.locked });

function openPsd(bytes: Uint8Array, name: string): Promise<Opened> {
  return openVia("psd", name, bytes);
}
function docFromOpened(o: Opened, title: string): OmwDocument {
  const doc = newDocument(title);
  doc.pages = o.pages!;
  doc.assets = { ...(o.assets ?? {}) };
  return doc;
}
const psdLayers = (page: Page) => page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode) as RasterNode[];

function verifyPsdLayers(file: string, bytes: Uint8Array, want: ReturnType<typeof layerExpect>[], header: { width: number; height: number; depth: number; mode: number }) {
  const L = parsePsdLayout(bytes);
  check(file, "헤더 크기·비트·색상 모드", [L.width, L.height, L.depth, L.mode], [header.width, header.height, header.depth, header.mode]);
  const img = decodePsd(bytes);
  const px = img.layers.filter((l) => l.kind === "pixel");
  check(file, "레이어 이름 (아래→위)", px.map((l) => l.name), want.map((l) => l.name));
  check(file, "혼합 모드", px.map((l) => l.blend), want.map((l) => l.blend));
  check(file, "불투명도 %", px.map((l) => Math.round(l.opacity * 100)), want.map((l) => l.opacityPct));
  check(file, "보임/숨김", px.map((l) => l.visible), want.map((l) => l.visible));
  check(file, "레이어 경계", px.map((l) => bounds(l.rgba!, l.width, l.height, l.left, l.top)), want.map((l) => l.bounds));
  checkTrue(file, "합쳐진 이미지(composite) 전체 크기", img.composite?.length === header.width * header.height * 4);
  // informational notes about how Omniweave DISPLAYS 16-bit / CMYK documents are expected, not problems
  const unexpected = img.warnings.filter((w) => !/^16비트 문서는 8비트로 보여 줍니다|^CMYK 문서에 들어 있는 색 프로필|^CMYK 문서는 잉크 값을 색 관리 없이|^프로필이 없는 CMYK 문서를 인쇄 표준|^들어 있는 프로필/.test(w));
  checkTrue(file, "읽기 경고 없음 (16비트·CMYK 표시 안내 제외)", unexpected.length === 0, unexpected);
  return img;
}

describe("PSD", () => {
  it("psd-01: new 8-bit RGB document, 6 layers (blend · opacity · hidden · locked)", async () => {
    const W = 320, H = 240;
    const specs: LayerSpec[] = [
      { name: "배경 Background", x: 0, y: 0, w: W, h: H, fn: gradient(W, H), blend: "NORMAL", opacityPct: 100, visible: true },
      { name: "빨간 사각형 Multiply", x: 30, y: 30, w: 120, h: 90, fn: solid([220, 30, 30, 255]), blend: "MULTIPLY", opacityPct: 80, visible: true },
      { name: "파란 원 Screen", x: 150, y: 60, w: 100, h: 100, fn: disc(100, [20, 60, 230, 255]), blend: "SCREEN", opacityPct: 50, visible: true },
      { name: "초록 띠 (숨김) Hidden", x: 10, y: 180, w: 300, h: 30, fn: solid([30, 180, 60, 255]), blend: "NORMAL", opacityPct: 100, visible: false },
      { name: "노란 삼각형 Overlay", x: 200, y: 130, w: 100, h: 80, fn: triangle(100, 80, [250, 210, 20, 255]), blend: "OVERLAY", opacityPct: 100, visible: true },
      { name: "보라 격자 HardLight (잠금)", x: 40, y: 130, w: 80, h: 80, fn: checker(10, [140, 60, 200, 255], [255, 255, 255, 255]), blend: "HARD_LIGHT", opacityPct: 70, visible: true, locked: true },
    ];
    const doc = newDocument("오메 PSD 새 문서");
    const page = doc.pages[0];
    page.width = W;
    page.height = H;
    page.nodes = []; // drop the default empty "배경 래스터" layer of a new document
    const want = specs.map((l) => {
      const rgba = rgbaImage(l.w, l.h, l.fn);
      const n = rasterFromRgba(rgba, l.w, l.h, l.name);
      n.transform = { x: l.x, y: l.y, rotation: 0, scale: 1 };
      n.blendMode = l.blend;
      n.opacity = l.opacityPct / 100;
      n.visible = l.visible;
      n.locked = !!l.locked;
      page.nodes.push(n);
      return layerExpect(l, rgba);
    });
    const res = await writePsd(doc, page);
    const file = "psd-01-new-rgb8-layers.psd";
    check(file, "저장 방식", res.method, "fresh");
    check(file, "저장 경고", res.warnings, []);
    add(
      {
        file,
        programs: ["Photoshop"],
        nature: "오메에서 새로 만든 문서를 PSD로 저장 (새 PSD 작성기)",
        checks: ["열 때 경고·오류 대화상자 없음", "레이어 6개, 이름(한글·영문 포함) 정확", "혼합 모드·불투명도·숨김(눈 아이콘 꺼짐)·잠금(자물쇠) 정확", "레이어 경계(선택 영역/정보 패널) 위치·크기", "합쳐진 모습이 오메 화면과 비슷함(곱하기·스크린 등 혼합 결과)", "다른 이름으로 저장 → 다시 열기 정상"],
        expected: { width: W, height: H, depth: 8, mode: "RGB", layerCount: 6, groups: [], layersBottomToTop: want, layersTopToBottomNames: want.map((l) => l.name).reverse() },
      },
      res.bytes,
    );
    const img = verifyPsdLayers(file, res.bytes, want, { width: W, height: H, depth: 8, mode: 3 });
    check(file, "잠금 플래그", img.layers.filter((l) => l.kind === "pixel").map((l) => (l.protect & 0x80000000) !== 0), want.map((l) => l.locked));
    check(file, "레코드 종류(그룹 없음)", img.layers.map((l) => l.kind), want.map(() => "pixel"));
  });

  it("psd-02: PSD with a group → opened in Omniweave → pixels, rename, add, reorder → saved", async () => {
    const W = 200, H = 150;
    const bg: LayerSpec = { name: "배경 Background", x: 0, y: 0, w: W, h: H, fn: gradient(W, H), blend: "NORMAL", opacityPct: 100, visible: true };
    const a: LayerSpec = { name: "그룹 안 A", x: 20, y: 20, w: 50, h: 40, fn: solid([220, 40, 40, 255]), blend: "NORMAL", opacityPct: 100, visible: true };
    const b: LayerSpec = { name: "그룹 안 B (Multiply)", x: 60, y: 50, w: 50, h: 40, fn: solid([40, 80, 220, 255]), blend: "MULTIPLY", opacityPct: 90, visible: true };
    const top: LayerSpec = { name: "바깥 위", x: 130, y: 80, w: 40, h: 40, fn: disc(40, [40, 170, 60, 255]), blend: "NORMAL", opacityPct: 100, visible: true };
    const GROUP = "그룹 1 Group";
    const srcLayers: FreshLayer[] = [
      freshLayer(bg),
      { name: "</Layer group>", px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(3)] },
      freshLayer(a),
      freshLayer(b),
      { name: GROUP, px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(1)] },
      freshLayer(top),
    ];
    const srcBytes = buildPsd({ width: W, height: H, layers: srcLayers });
    save("psd-02-source.psd", srcBytes, SRC);

    // open exactly like the app (format registry), edit, save with the PSD export
    const opened = await openPsd(srcBytes, "psd-02-source.psd");
    const doc = docFromOpened(opened, "psd-02");
    const page = doc.pages[0];
    const [nBg, nA, nB, nTop] = psdLayers(page);
    // folders are layer groups (plain layer names; membership in page.groups)
    expect(nA.name).toBe(a.name);
    expect(page.groups?.find((g) => g.id === nA.groupId)?.name).toBe(GROUP);
    const editedA = paintRect(nA, 5, 5, 20, 20, [250, 220, 0, 255]);
    const RENAMED = "이름 바꾼 레이어 Renamed";
    const renamed: RasterNode = { ...nTop, name: RENAMED };
    const added: LayerSpec = { name: "새 레이어 New", x: 150, y: 10, w: 30, h: 30, fn: solid([230, 0, 200, 255]), blend: "SCREEN", opacityPct: 60, visible: true };
    const addedRgba = rgbaImage(added.w, added.h, added.fn);
    const nNew = rasterFromRgba(addedRgba, added.w, added.h, added.name);
    nNew.transform = { x: added.x, y: added.y, rotation: 0, scale: 1 };
    nNew.blendMode = added.blend;
    nNew.opacity = added.opacityPct / 100;
    const composite = page.nodes.find((n) => n.id === page.source?.psd?.compositeNode)!;
    // bottom → top: background, B, A (swapped inside the group), renamed top layer, new layer
    page.nodes = [nBg, nB, editedA, renamed, nNew, composite];
    const out = await exportVia("psd", doc, page);
    const res = await writePsd(doc, page);
    const file = "psd-02-edited-groups.psd";
    check(file, "저장 방식", res.method, "surgery");
    checkTrue(file, "레지스트리 저장 = writePsd 결과", bytesEq(out, res.bytes));

    const aRgba = rgbaImage(a.w, a.h, a.fn);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) aRgba.set([250, 220, 0, 255], (y * a.w + x) * 4);
    const want = [layerExpect(bg, rgbaImage(bg.w, bg.h, bg.fn)), layerExpect(b, rgbaImage(b.w, b.h, b.fn)), layerExpect(a, aRgba), { ...layerExpect(top, rgbaImage(top.w, top.h, top.fn)), name: RENAMED }, layerExpect(added, addedRgba)];
    const structure = ["pixel:" + bg.name, "groupEnd:</Layer group>", "pixel:" + b.name, "pixel:" + a.name, "group:" + GROUP, "pixel:" + RENAMED, "pixel:" + added.name];
    add(
      {
        file,
        programs: ["Photoshop"],
        nature: "그룹이 있는 PSD를 오메로 열어 고친 뒤 '원래 형식으로 저장' (PSD Surgeon 부분 다시 쓰기)",
        source: "_source/psd-02-source.psd",
        checks: [
          "열 때 경고 없음",
          `그룹 '${GROUP}' 1개, 그 안에 레이어 2개 (위에서부터 '${a.name}', '${b.name}' — 원본과 순서가 바뀜)`,
          `'${a.name}' 왼쪽 위에 노란 사각형 20×20(픽셀 수정 반영)`,
          `맨 위 '${added.name}'(스크린 60%) 추가, '바깥 위' → '${RENAMED}' 이름 변경`,
          "원본(_source)과 비교: 수정하지 않은 레이어(배경·B)의 픽셀·속성이 그대로",
          "합쳐진 이미지가 레이어 결과와 일치(파일 썸네일·Bridge 미리보기)",
        ],
        expected: { width: W, height: H, depth: 8, mode: "RGB", layerCount: 5, groups: [{ name: GROUP, childrenTopToBottom: [a.name, b.name] }], recordsBottomToTop: structure, layersBottomToTop: want, layersTopToBottomNames: want.map((l) => l.name).reverse() },
      },
      res.bytes,
    );
    const img = verifyPsdLayers(file, res.bytes, want, { width: W, height: H, depth: 8, mode: 3 });
    check(file, "레코드 구조 (아래→위)", img.layers.map((l) => `${l.kind}:${l.name}`), structure);
    check(file, "그룹 소속", img.layers.filter((l) => l.kind === "pixel").map((l) => l.group), [[], [GROUP], [GROUP], [], []]);
    // a second save without edits keeps the bytes (stable round trip)
    const again = await openPsd(res.bytes, file);
    const d2 = docFromOpened(again, "again");
    const r2nd = await writePsd(d2, d2.pages[0]);
    check(file, "다시 열어 무편집 저장 = 같은 바이트", [r2nd.method, bytesEq(r2nd.bytes, res.bytes)], ["original", true]);
  });

  for (const v of [
    { id: "03", tag: "rgb16", depth: 16, mode: 3, modeName: "RGB", program: "16비트 RGB" },
    { id: "04", tag: "cmyk8", depth: 8, mode: 4, modeName: "CMYK", program: "8비트 CMYK" },
  ]) {
    it(`psd-${v.id}: ${v.program} PSD opened in Omniweave and saved without edits (+ edited variant)`, async () => {
      const W = 160, H = 120;
      const specs: LayerSpec[] = [
        { name: `${v.modeName} 배경`, x: 0, y: 0, w: W, h: H, fn: gradient(W, H), blend: "NORMAL", opacityPct: 100, visible: true },
        { name: `${v.modeName} 빨간 사각형`, x: 20, y: 20, w: 60, h: 40, fn: solid([220, 30, 30, 255]), blend: "MULTIPLY", opacityPct: 75, visible: true },
        { name: `${v.modeName} 숨김 원`, x: 90, y: 40, w: 50, h: 50, fn: disc(50, [20, 160, 60, 255]), blend: "NORMAL", opacityPct: 100, visible: false },
      ];
      const src = buildPsd({ width: W, height: H, depth: v.depth, mode: v.mode, layers: specs.map(freshLayer) });
      const opened = await openPsd(src, `psd-${v.id}.psd`);
      const doc = docFromOpened(opened, v.tag);
      const page = doc.pages[0];
      const unchanged = await exportVia("psd", doc, page);
      const file = `psd-${v.id}-${v.tag}-unedited.psd`;
      check(file, "무편집 저장 = 원본 바이트", bytesEq(unchanged, src), true);
      const want = specs.map((l) => layerExpect(l, rgbaImage(l.w, l.h, l.fn)));
      add(
        {
          file,
          programs: ["Photoshop"],
          nature: `오메가 만든 ${v.program} PSD를 오메로 열어 고치지 않고 저장 (원본 바이트 그대로여야 함)`,
          checks: [`이미지 → 모드가 '${v.modeName} 색상 / ${v.depth}비트/채널'`, "레이어 3개 이름·혼합 모드·불투명도·숨김 정확", v.mode === 4 ? "채널 패널에 C·M·Y·K 4채널, 색이 크게 틀어지지 않음(빨강·초록 구분)" : "16비트 그라데이션 배경이 계단 없이 부드러움", "열 때 경고 없음"],
          expected: { width: W, height: H, depth: v.depth, mode: v.modeName, layerCount: 3, groups: [], layersBottomToTop: want, layersTopToBottomNames: want.map((l) => l.name).reverse() },
        },
        unchanged,
      );
      verifyPsdLayers(file, unchanged, want, { width: W, height: H, depth: v.depth, mode: v.mode });

      // edited variant: one layer's pixels changed → surgery in the same mode/depth
      const file2 = `psd-${v.id}-${v.tag}-edited.psd`;
      try {
        const [, red] = psdLayers(page);
        const edited = paintRect(red, 10, 10, 20, 20, [250, 220, 0, 255]);
        page.nodes = page.nodes.map((n) => (n.id === red.id ? edited : n));
        const res = await writePsd(doc, page);
        check(file2, "저장 방식", res.method, "surgery");
        const redRgba = rgbaImage(specs[1].w, specs[1].h, specs[1].fn);
        for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) redRgba.set([250, 220, 0, 255], (y * specs[1].w + x) * 4);
        const want2 = [want[0], layerExpect(specs[1], redRgba), want[2]];
        add(
          {
            file: file2,
            programs: ["Photoshop"],
            nature: `${v.program} PSD를 오메로 열어 레이어 1개 픽셀을 고쳐 저장 (PSD Surgeon, ${v.modeName}/${v.depth}비트 유지)`,
            checks: [`모드 '${v.modeName} / ${v.depth}비트' 유지`, `'${specs[1].name}' 안쪽에 노란 사각형 20×20`, "다른 레이어는 _unedited 파일과 같음", "열 때 경고 없음"],
            expected: { width: W, height: H, depth: v.depth, mode: v.modeName, layerCount: 3, groups: [], layersBottomToTop: want2, layersTopToBottomNames: want2.map((l) => l.name).reverse() },
          },
          res.bytes,
        );
        verifyPsdLayers(file2, res.bytes, want2, { width: W, height: H, depth: v.depth, mode: v.mode });
      } catch (e: any) {
        DEFECTS.push(`${file2}: 편집 저장 실패 — ${e?.message ?? e}`);
        checkTrue(file2, "편집 저장 가능", false, String(e?.message ?? e));
      }
    });
  }
});

// ═════════════════════════════ PDF ═════════════════════════════

const KO_EN = "테스트 Test 한글";

function textNode(text: string, x: number, y: number, width: number, run: Partial<TextRun> = {}): TextNode {
  const t = newText(text, width, run);
  t.transform = { x, y, rotation: 0, scale: 1 };
  return t;
}

describe("PDF", () => {
  let vectorPdf: Uint8Array;
  const PDF_TITLE = "오메 호환 시험 PDF";

  it("pdf-01: vector PDF export (Korean/English text, table, vectors, image, 3 pages of 2 sizes)", async () => {
    const doc = newDocument(PDF_TITLE);
    const img = makeAsset(pngOf(96, 64, (x, y) => [x * 2 + 40, y * 3 + 30, 180, 255]), "image/png", "gradient.png");
    doc.assets[img.id] = img;

    const p1 = newPage("DOCUMENT", 794, 1123, "1쪽 본문");
    const h = textNode(`PDF 제목 — ${KO_EN}`, 76, 70, 640, { fontSize: 28, bold: true });
    const body = textNode(`본문 첫 문단입니다. ${KO_EN} 글자는 선택·검색할 수 있어야 합니다.`, 76, 130, 640, { fontSize: 16 });
    body.paragraphs.push(newParagraph("굵은 글씨 Bold text", { bold: true, fontSize: 16 }), newParagraph("빨간 기울임 Red italic", { italic: true, color: "#c00000", fontSize: 16 }));
    const table = newTable(
      [
        ["구분 Item", "값 Value", "비고 Note"],
        ["가나다", "123", "한글 셀"],
        ["ABC", "45.6", "English cell"],
      ],
      [160, 120, 200],
      "PDF 표",
    );
    table.transform = { x: 76, y: 300, rotation: 0, scale: 1 };
    const rect = newVector([rectContour(76, 470, 200, 120)], "파란 사각형");
    rect.fill = "#2f6fdf";
    rect.stroke = "#000000";
    rect.strokeWidth = 3;
    const ell = newVector([ellipseContour(420, 530, 90, 60)], "주황 타원");
    ell.fill = "#f08020";
    ell.opacity = 0.7;
    const image = newImage(img.id, 192, 128, "그라데이션 그림");
    image.transform = { x: 540, y: 470, rotation: 0, scale: 1 };
    p1.nodes.push(h, body, table, rect, ell, image);

    const p2 = newPage("DOCUMENT", 794, 1123, "2쪽");
    p2.nodes.push(textNode(`2쪽 두 번째 페이지 Second page — ${KO_EN}`, 76, 76, 640, { fontSize: 20 }));
    const p3 = newPage("SLIDE", 1280, 720, "3쪽 가로 슬라이드");
    p3.nodes.push(textNode(`3쪽 가로 페이지 Landscape — ${KO_EN}`, 80, 80, 1000, { fontSize: 36, bold: true }));
    doc.pages = [p1, p2, p3];

    const warnings: string[] = [];
    vectorPdf = await exportPdfVector(doc, doc.pages, { fonts: { regular: FONT_REG, bold: FONT_BOLD }, onWarning: (m) => warnings.push(m) });
    const file = "pdf-01-vector-export.pdf";
    check(file, "내보내기 경고", warnings, []);
    const pageTexts = [
      [`PDF 제목 — ${KO_EN}`, `본문 첫 문단입니다. ${KO_EN} 글자는 선택·검색할 수 있어야 합니다.`, "굵은 글씨 Bold text", "빨간 기울임 Red italic", "구분 Item", "값 Value", "비고 Note", "가나다", "123", "한글 셀", "ABC", "45.6", "English cell"],
      [`2쪽 두 번째 페이지 Second page — ${KO_EN}`],
      [`3쪽 가로 페이지 Landscape — ${KO_EN}`],
    ];
    const sizesPt: [number, number][] = [
      [595.5, 842.25],
      [595.5, 842.25],
      [960, 540],
    ];
    add(
      {
        file,
        programs: ["Acrobat Pro", "Illustrator(참고)"],
        nature: "오메 문서를 '벡터 PDF'로 내보내기 (글자는 실제 텍스트, 도형은 패스)",
        checks: ["열 때 경고 없음", "쪽 수 3, 1·2쪽 A4 세로, 3쪽 가로(960×540pt)", "Ctrl+F로 '테스트', 'Test', '한글' 검색됨 · 글자 드래그 선택·복사 시 같은 글자", "문서 속성 → 글꼴: Pretendard(포함된 하위 집합)", "표·사각형·타원(반투명)·그림이 보임", "책갈피 3개(쪽 이름)", "프리플라이트 'PDF 구문 문제 보고' 결과 기록"],
        expected: { pages: 3, pageSizesPt: sizesPt, title: PDF_TITLE, fonts: ["Pretendard (subset)"], bookmarks: doc.pages.map((p) => p.name), textPerPage: pageTexts },
      },
      vectorPdf,
    );
    const got = await pdfTexts(vectorPdf);
    check(file, "쪽 수", got.length, 3);
    got.forEach((t, i) => pageTexts[i].forEach((s) => checkTrue(file, `${i + 1}쪽 텍스트 '${s}'`, squash(t).includes(squash(s)))));
    check(file, "쪽 크기(pt)", await pdfSizes(vectorPdf), sizesPt);
    const d = await openJs(vectorPdf);
    check(file, "제목 메타데이터", (await d.getMetadata()).info.Title, PDF_TITLE);
    check(file, "책갈피", ((await d.getOutline()) ?? []).map((o: any) => o.title), doc.pages.map((p) => p.name));
    await d.destroy();
    const sd = await openSurgeonDoc(vectorPdf);
    check(file, "오메 PDF Surgeon으로 열림(쪽 수)", sd.pageRefs.length, 3);
  });

  it("pdf-02: vector PDF encrypted with AES-256 (R6)", async () => {
    const enc = await encryptPdf(vectorPdf, PW);
    const file = "pdf-02-vector-export-aes256-r6.pdf";
    add(
      {
        file,
        programs: ["Acrobat Pro"],
        password: PW,
        nature: "pdf-01을 오메의 'PDF 암호' 기능으로 AES-256(R6) 암호화",
        checks: ["열 때 암호 입력 창이 뜸 · 틀린 암호는 거부", `암호 '${PW}'로 열림`, "문서 속성 → 보안: 암호 보안, 256비트 AES", "내용·쪽 수가 pdf-01과 같음", "프리플라이트 'PDF 구문 문제 보고' 결과 기록"],
        expected: { pages: 3, encryption: "Standard V5 R6 AES-256", userPassword: PW, textPerPage: "pdf-01과 같음" },
      },
      enc,
    );
    let refused = false;
    try {
      await (await openJs(enc)).destroy();
    } catch {
      refused = true;
    }
    checkTrue(file, "암호 없이는 열리지 않음", refused);
    check(file, "암호로 연 텍스트 = pdf-01", (await pdfTexts(enc, PW)).map(squash), (await pdfTexts(vectorPdf)).map(squash));
    const sd = await openSurgeonDoc(enc, PW);
    check(file, "암호 방식 R", sd.encryption?.R, 6);
  });

  // source PDFs for PDF Surgeon (pdf-lib, Helvetica + subset CID font) — reference input, not an Omniweave save
  async function surgeonSource(kind: "pdf" | "ai"): Promise<Uint8Array> {
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    d.setTitle(kind === "ai" ? "AI interop source" : "PDF Surgeon interop source");
    const helv = await d.embedFont(StandardFonts.Helvetica);
    const ko = await d.embedFont(FONT_REG, { subset: true });
    if (kind === "pdf") {
      const p = d.addPage([500, 400]);
      p.drawText("Original line for Surgeon edit", { x: 40, y: 340, size: 18, font: helv, color: rgb(0.1, 0.1, 0.4) });
      p.drawText("Second line stays the same", { x: 40, y: 310, size: 12, font: helv });
      p.drawText(`${KO_EN} 원본 문장`, { x: 40, y: 280, size: 14, font: ko });
      p.drawRectangle({ x: 40, y: 60, width: 160, height: 100, color: rgb(1, 0, 0) });
      p.drawRectangle({ x: 240, y: 60, width: 160, height: 100, color: rgb(0, 0, 1), borderColor: rgb(0, 0.5, 0), borderWidth: 3 });
      const p2 = d.addPage([500, 400]);
      p2.drawText("Page 2 is not edited", { x: 40, y: 340, size: 16, font: helv });
      p2.drawText("둘째 쪽 한글 문장", { x: 40, y: 310, size: 14, font: ko });
      p2.drawRectangle({ x: 40, y: 60, width: 120, height: 80, color: rgb(0.2, 0.7, 0.2) });
    } else {
      const p = d.addPage([600, 450]);
      p.drawRectangle({ x: 0, y: 0, width: 600, height: 450, color: rgb(0.96, 0.96, 0.92) });
      p.drawEllipse({ x: 160, y: 220, xScale: 110, yScale: 80, color: rgb(1, 0.5, 0) });
      p.drawRectangle({ x: 330, y: 150, width: 200, height: 140, color: rgb(0.2, 0.4, 0.9), borderColor: rgb(0, 0, 0), borderWidth: 2 });
      p.drawText("Illustrator test text", { x: 40, y: 400, size: 20, font: helv });
      p.drawText(`일러스트 ${KO_EN}`, { x: 40, y: 60, size: 16, font: ko });
    }
    return d.save({ useObjectStreams: false });
  }

  function editText(nodes: SceneNode[], from: string, to: string): SceneNode[] {
    let hit = 0;
    const out = nodes.map((n) => {
      if (n.type !== "TEXT" || n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("") !== from) return n;
      hit++;
      const p0 = n.paragraphs[0];
      return { ...n, paragraphs: [{ ...p0, runs: [{ ...p0.runs[0], text: to }] }] };
    });
    if (hit !== 1) throw new Error(`text line '${from}' found ${hit}×`);
    return out;
  }
  function recolor(nodes: SceneNode[], from: string, to: string): SceneNode[] {
    let hit = 0;
    const out = nodes.map((n) => (n.type === "VECTOR" && n.fill === from && !hit++ ? { ...n, fill: to } : n));
    if (hit !== 1) throw new Error(`vector with fill ${from} not found`);
    return out;
  }
  const fillsOf = (doc: SurgeonDoc, i: number) => elevatePage(doc, i, { prefix: "kit", vectors: true }).nodes.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => n.fill);
  const fallbackFont = async () => FONT_REG;

  let surgeonOut: Uint8Array;
  it("pdf-03: PDF Surgeon — one Latin line, one Korean line and one fill colour edited, incremental save", async () => {
    const src = await surgeonSource("pdf");
    save("pdf-03-source.pdf", src, SRC);
    const sd = await openSurgeonDoc(src);
    const el = elevatePage(sd, 0, { prefix: "kit", vectors: true });
    const KO_FROM = `${KO_EN} 원본 문장`, KO_TO = `${KO_EN} 수정 문장`;
    let nodes = editText(el.nodes, "Original line for Surgeon edit", "Edited by Omniweave Surgeon 1234");
    nodes = editText(nodes, KO_FROM, KO_TO);
    nodes = recolor(nodes, "#ff0000", "#00aa00");
    const { bytes, report } = await saveSurgical(sd, [{ pageIndex: 0, nodes, elevated: true }, { pageIndex: 1, nodes: [], elevated: false }], { prefix: "kit", vectors: true, fallbackFont });
    surgeonOut = bytes;
    const file = "pdf-03-surgeon-edited.pdf";
    const newChars = [...new Set([...KO_TO].filter((c) => c.trim() && !KO_FROM.includes(c)))].sort();
    check(file, "보고서: 바뀐 줄·패스", [report.changed, report.editedText, report.editedVectors, report.skipped], [true, 2, 1, []]);
    check(file, "대체 글꼴로 쓴 글자(원본 하위 글꼴에 없는 글자)", [...report.fallbackChars].sort(), newChars);
    const texts = [
      ["Edited by Omniweave Surgeon 1234", "Second line stays the same", KO_TO],
      ["Page 2 is not edited", "둘째 쪽 한글 문장"],
    ];
    add(
      {
        file,
        programs: ["Acrobat Pro"],
        nature: "pdf-lib로 만든 PDF(_source)를 오메 PDF Surgeon으로 열어 텍스트 2줄·도형 색 1개를 고쳐 '원래 형식으로 저장' (증분 저장: 원본 바이트 뒤에 고친 부분만 덧붙임)",
        source: "_source/pdf-03-source.pdf",
        checks: [
          "열 때 경고 없음, '이 문서는 손상되었습니다/복구' 메시지 없음",
          "1쪽 첫 줄 'Edited by Omniweave Surgeon 1234' (Helvetica 그대로), 'Original line…'은 사라짐",
          `1쪽 한글 줄 '${KO_TO}' — 원본 글꼴에 없던 '${newChars.join("")}'만 대체 글꼴(Pretendard)`,
          "1쪽 왼쪽 사각형 빨강 → 초록(#00AA00), 오른쪽 파란 사각형·테두리 그대로",
          "2쪽은 원본과 똑같음 (도구 → 파일 비교로 _source와 비교)",
          "검색 'Edited', '수정' 검색됨",
          "프리플라이트 'PDF 구문 문제 보고' 결과 기록",
        ],
        expected: { pages: 2, pageSizesPt: [[500, 400], [500, 400]], incrementalUpdate: true, originalBytesPrefix: src.length, textPerPage: texts, removedText: ["Original line for Surgeon edit", KO_FROM], fillsPage1: ["#00aa00", "#0000ff"], fallbackChars: newChars },
      },
      bytes,
    );
    checkTrue(file, "증분 저장: 원본 바이트가 앞부분에 그대로", bytesEq(bytes.subarray(0, src.length), src));
    const got = await pdfTexts(bytes);
    check(file, "쪽 수", got.length, 2);
    texts.forEach((ts, i) => ts.forEach((s) => checkTrue(file, `${i + 1}쪽 텍스트 '${s}'`, squash(got[i]).includes(squash(s)))));
    checkTrue(file, "원래 줄이 사라짐", !squash(got[0]).includes("Originalline") && !squash(got[0]).includes(squash(KO_FROM)));
    check(file, "2쪽 텍스트 = 원본", got[1], (await pdfTexts(src))[1]);
    const back = await openSurgeonDoc(bytes);
    check(file, "1쪽 도형 채움색(다시 승격)", fillsOf(back, 0), ["#00aa00", "#0000ff"]);
  });

  it("pdf-04: the Surgeon-edited PDF re-encrypted with AES-256 (R6)", async () => {
    const enc = await encryptPdf(surgeonOut, PW);
    const file = "pdf-04-surgeon-edited-aes256-r6.pdf";
    add(
      {
        file,
        programs: ["Acrobat Pro"],
        password: PW,
        nature: "pdf-03(증분 저장된 PDF)을 다시 AES-256(R6)으로 암호화 (오메가 저장 시 원래 암호를 다시 거는 경로)",
        checks: [`암호 '${PW}'로 열림, 틀린 암호 거부`, "내용이 pdf-03과 같음(고친 줄·초록 사각형)", "문서 속성 → 보안: 256비트 AES", "프리플라이트 'PDF 구문 문제 보고' 결과 기록"],
        expected: { pages: 2, encryption: "Standard V5 R6 AES-256", userPassword: PW, textPerPage: "pdf-03과 같음" },
      },
      enc,
    );
    check(file, "암호로 연 텍스트 = pdf-03", (await pdfTexts(enc, PW)).map(squash), (await pdfTexts(surgeonOut)).map(squash));
    const sd = await openSurgeonDoc(enc, PW);
    check(file, "1쪽 도형 채움색", fillsOf(sd, 0), ["#00aa00", "#0000ff"]);
  });

  it("ai-01: PDF saved as .ai, edited with PDF Surgeon (text + fill colour)", async () => {
    const src = await surgeonSource("ai");
    save("ai-01-source.ai", src, SRC);
    const opened = await openSurgeonDoc(src);
    const el = elevatePage(opened, 0, { prefix: "kit", vectors: true });
    const fillsBefore = el.nodes.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => n.fill);
    let nodes = editText(el.nodes, "Illustrator test text", "Illustrator text edited by Omniweave");
    nodes = recolor(nodes, "#ff8000", "#8000ff");
    const { bytes, report } = await saveSurgical(opened, [{ pageIndex: 0, nodes, elevated: true }], { prefix: "kit", vectors: true, fallbackFont });
    const file = "ai-01-pdf-as-ai-surgeon-edited.ai";
    const fillsAfter = fillsBefore.map((f) => (f === "#ff8000" ? "#8000ff" : f));
    check(file, "보고서", [report.changed, report.editedText, report.editedVectors, report.illustratorDataRemoved, report.skipped], [true, 1, 1, false, []]);
    add(
      {
        file,
        programs: ["Illustrator", "Acrobat Pro(참고)"],
        nature:
          "주의: 진짜 Illustrator 원본이 아님 — pdf-lib로 만든 PDF에 .ai 확장자를 붙인 시험 파일(Illustrator 전용 데이터 PieceInfo 없음)을 오메 PDF Surgeon으로 고쳐 .ai로 저장. Illustrator가 'PDF 호환 .ai'의 PDF 내용을 그대로 읽는지만 확인합니다 (진짜 .ai 왕복은 검수 PC의 adobe-made 기준 파일로 별도 시험)",
        source: "_source/ai-01-source.ai",
        checks: ["Illustrator에서 열 때 오류 없음(경고가 뜨면 문구 기록)", "글자 'Illustrator text edited by Omniweave'가 보이고 문자 도구로 선택·수정 가능", "원 채움 주황 → 보라(#8000FF), 사각형(파랑·검정 테두리)·배경 그대로", `한글 줄 '일러스트 ${KO_EN}' 그대로`, "대지 크기 600×450pt", "Acrobat에서도 열림(참고)"],
        expected: { pages: 1, artboardPt: [600, 450], text: ["Illustrator text edited by Omniweave", `일러스트 ${KO_EN}`], removedText: ["Illustrator test text"], fills: fillsAfter, illustratorPrivateData: false },
      },
      bytes,
    );
    const got = await pdfTexts(bytes);
    for (const s of ["Illustrator text edited by Omniweave", `일러스트 ${KO_EN}`]) checkTrue(file, `텍스트 '${s}'`, squash(got[0]).includes(squash(s)));
    checkTrue(file, "원래 글자 사라짐", !got[0].includes("Illustrator test text"));
    // pdf-lib drawEllipse builds the path inside q…Q and paints after the Q: the new colour must be set at the paint
    check(file, "채움색(다시 승격)", fillsOf(await openSurgeonDoc(bytes), 0), fillsAfter);
    check(file, "대지 크기", await pdfSizes(bytes), [[600, 450]]);
    // the app opens .ai through its own registry entry (PDF-compatible check)
    checkTrue(file, "오메 .ai 형식으로 인식(PDF 호환)", formatForExt("ai")?.id === "ai");
  });
});

// ═════════════════════════════ DOCX · HWPX ═════════════════════════════

const BODY = 16; // px = 12pt
const R = (text: string, f: Partial<TextRun> = {}): TextRun => ({ ...newParagraph("", { fontSize: BODY }).runs[0], ...f, text });
function P(runs: TextRun[] | string, p: Partial<TextParagraph> = {}): TextParagraph {
  const base = newParagraph("", { fontSize: BODY });
  return { ...base, lineSpacing: 1.6, spaceAfter: 8, ...p, runs: typeof runs === "string" ? [R(runs)] : runs };
}
const H = (level: 1 | 2 | 3, text: string) => P([R(text, { bold: true, fontSize: { 1: 32, 2: 24, 3: 20 }[level] })], { role: `h${level}` as TextParagraph["role"], spaceAfter: 12 });
const LONG = "오메 호환 시험 문단입니다. 이 문장은 줄바꿈과 정렬을 확인하기 위해 일부러 길게 썼습니다. Omniweave interop paragraph for checking wrapping and alignment. 테스트 Test 한글.";

interface Fmt {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  script?: "super" | "sub";
  color?: string;
  highlight?: string;
  letterSpacing?: number;
  fontFamily?: string;
}
const FORMAT_RUNS: Fmt[] = [
  { text: "보통 Normal " },
  { text: "굵게 Bold", bold: true },
  { text: " " },
  { text: "기울임 Italic", italic: true },
  { text: " " },
  { text: "밑줄 Underline", underline: true },
  { text: " " },
  { text: "취소선 Strike", strike: true },
  { text: " H" },
  { text: "2", script: "sub" },
  { text: "O x" },
  { text: "2", script: "super" },
  { text: " " },
  { text: "빨간 글자 Red", color: "#C00000" },
  { text: " " },
  { text: "형광펜 Highlight", highlight: "#FFFF00" },
  { text: " " },
  { text: "자간 넓게 Spacing", letterSpacing: 2 },
  { text: " " },
  { text: "맑은 고딕 글꼴", fontFamily: "맑은 고딕" },
];
const ALIGNS = [
  { align: "LEFT", label: "왼쪽 정렬 Left" },
  { align: "CENTER", label: "가운데 정렬 Center" },
  { align: "RIGHT", label: "오른쪽 정렬 Right" },
  { align: "JUSTIFY", label: "양쪽 정렬 Justify" },
] as const;
const INDENTS = [
  { label: "첫 줄 들여쓰기 32px(24pt)", indent: 32, indentLeft: 0 },
  { label: "내어쓰기 24px(18pt), 왼쪽 여백 48px(36pt)", indent: -24, indentLeft: 48 },
  { label: "왼쪽 여백 64px(48pt)", indent: 0, indentLeft: 64 },
];
const SPACINGS = [1.0, 1.5, 2.0];
const BULLETS = ["글머리 항목 하나 Bullet one", "글머리 항목 둘 Bullet two", "글머리 항목 셋 Bullet three"];
const NUMBERED = ["번호 항목 하나 Numbered one", "번호 항목 둘 Numbered two", "번호 항목 셋 Numbered three"];
const TABLE_ROWS = [
  ["구분 Item", "수량 Qty", "비고 Note"],
  ["사과", "3", "한글 셀"],
  ["Banana", "12", "English cell"],
  ["합계 Total", "15", "굵게 아님"],
];
const FILLER = 30;

function officeDoc(title: string): { doc: OmwDocument; paras: TextParagraph[] } {
  const part1: TextParagraph[] = [
    H(1, "제목 1 — 오메 호환 시험 Heading 1"),
    H(2, "제목 2 — 글자 서식 Heading 2"),
    P(FORMAT_RUNS.map(({ text, ...f }) => R(text, f))),
    H(3, "제목 3 — 문단 정렬 Heading 3"),
    ...ALIGNS.map((a) => P(`${a.label}: ${LONG}`, { align: a.align })),
    H(3, "제목 3 — 들여쓰기와 줄 간격 Indent & spacing"),
    ...INDENTS.map((d) => P(`${d.label}: ${LONG}`, { indent: d.indent, ...(d.indentLeft ? { indentLeft: d.indentLeft } : {}) })),
    ...SPACINGS.map((s) => P(`줄 간격 ${s.toFixed(1)}배(오메 기준) Line spacing ${s.toFixed(1)}: ${LONG}`, { lineSpacing: s })),
    H(2, "목록 Lists"),
    ...BULLETS.map((t) => P(t)),
    ...NUMBERED.map((t) => P(t)),
  ];
  // lists through the editor's own list command (markers are real text)
  const b0 = part1.length - BULLETS.length - NUMBERED.length;
  let listed = toggleList(part1, b0, b0 + BULLETS.length - 1, "li").paras;
  listed = toggleList(listed, b0 + BULLETS.length, b0 + BULLETS.length + NUMBERED.length - 1, "oli").paras;
  const pages1 = paginate(listed, title);

  // table page: caption text, then the table (TABLE node → Word table; HWPX: tab-separated paragraphs)
  const tp = newPage("DOCUMENT", 794, 1123, `${title} · 표`);
  const cap = newText("", 642);
  cap.paragraphs = [H(2, "표 Table")];
  cap.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
  const tbl = newTable(TABLE_ROWS, [200, 120, 220], "문서 표");
  tbl.transform = { x: 76, y: 140, rotation: 0, scale: 1 };
  tp.nodes.push(cap, tbl);

  const part2: TextParagraph[] = [H(2, "긴 본문 — 쪽 넘김 확인 Long body"), ...Array.from({ length: FILLER }, (_, i) => P(`문단 ${i + 1}. ${LONG}`))];
  const pages2 = paginate(part2, title);
  const doc = newDocument(title);
  doc.pages = [...pages1, tp, ...pages2];
  return { doc, paras: [...listed, ...cap.paragraphs, ...part2] };
}

const paraText = (p: TextParagraph) => p.runs.map((r) => r.text).join("");

function officeExpected(paras: TextParagraph[], fmt: "docx" | "hwpx") {
  const twip = (px: number) => Math.round((px / (96 / 72)) * 20);
  return {
    headings: paras.filter((p) => p.role && /^h\d$/.test(p.role)).map((p) => ({ level: Number(p.role!.slice(1)), text: paraText(p) })),
    formatRuns: FORMAT_RUNS.filter((f) => f.text.trim()).map((f) => ({ ...f, text: f.text.trim(), sizePt: 12 })),
    bodyFont: "Pretendard (미설치 PC에서는 대체 글꼴로 보임 — 글꼴 이름 칸에 'Pretendard'면 정상)",
    bodySizePt: 12,
    alignments: ALIGNS.map((a) => ({ startsWith: a.label, align: a.align })),
    indents: INDENTS.map((d) => ({ startsWith: d.label, firstLinePt: d.indent > 0 ? d.indent * 0.75 : 0, hangingPt: d.indent < 0 ? -d.indent * 0.75 : 0, leftPt: d.indentLeft * 0.75 })),
    lineSpacing: SPACINGS.map((s) =>
      fmt === "docx"
        ? {
            startsWith: `줄 간격 ${s.toFixed(1)}배`,
            omniweave: s,
            wordMultiple: r2(wordLine(s, "Pretendard", "한글") / 240),
            lineHeightPt: r2(s * 12),
            note: "오메 배수 = 글자 크기 기준, Word '배수' = 글꼴 한 줄 높이 기준 → Word 배수 = 오메 배수 ÷ (Word의 한 줄 높이 ÷ 글자 크기). 한글이 든 Pretendard 줄은 1.566(글꼴 Windows 높이 1.193 × Word 동아시아 배율 1.3125). Pretendard가 없는 PC에서는 대체 글꼴의 줄 높이로 보여 줄 높이가 달라질 수 있음(맑은 고딕으로 쓴 문단은 이 PC Word 2021에서 1.0/1.5/2.0배 = 12/18/24pt 줄 간격 실측)",
          }
        : { startsWith: `줄 간격 ${s.toFixed(1)}배`, omniweave: s, hwpPercent: Math.round(s * 100) },
    ),
    bullets: BULLETS,
    numbered: NUMBERED,
    listNote:
      fmt === "docx"
        ? "Word 자동 목록: 글머리 기호 '•' 3줄, 번호 '1. 2. 3.' 3줄 (기호·번호는 본문 글자가 아님 — 클릭하면 목록 서식, '목록 수준'·'번호 매기기' 단추가 켜짐)"
        : "한글 문단 번호/글머리표: 글머리표 '•' 3줄, 문단 번호 '1. 2. 3.' 3줄 (기호·번호는 본문 글자가 아님)",
    table:
      fmt === "docx"
        ? { kind: "Word 표", rows: TABLE_ROWS.length, cols: 3, cells: TABLE_ROWS, headerRowBold: true, mergedCells: "없음(병합은 tests/quality에서 검증)" }
        : { kind: "한글 표 (hp:tbl, 테두리 실선, 제목 행 음영·반복)", rows: TABLE_ROWS.length, cols: 3, cells: TABLE_ROWS, headerRowBold: true },
    minPages: 3,
    fillerParagraphs: FILLER,
    lastParagraph: `문단 ${FILLER}. ${LONG}`,
    twipsCheck: fmt === "docx" ? { firstLine32px: twip(32) } : undefined,
  };
}

function verifyOffice(file: string, paras: TextParagraph[], tables: import("../src/core/types").TableNode[], fmt: "docx" | "hwpx", pages: number) {
  const texts = paras.map(paraText);
  const find = (start: string) => paras.find((p) => paraText(p).startsWith(start));
  check(
      file,
      "제목 1~3 (role)",
      paras.filter((p) => p.role && /^h\d$/.test(p.role)).map((p) => `${p.role}:${paraText(p)}`),
      ["제목 1 — 오메 호환 시험 Heading 1", "제목 2 — 글자 서식 Heading 2", "제목 3 — 문단 정렬 Heading 3", "제목 3 — 들여쓰기와 줄 간격 Indent & spacing", "목록 Lists", "표 Table", "긴 본문 — 쪽 넘김 확인 Long body"].map(
        (t, i) => `h${[1, 2, 3, 3, 2, 2, 2][i]}:${t}`,
      ),
    );
  const fp = find("보통 Normal");
  checkTrue(file, "서식 문단 있음", !!fp);
  if (fp) {
    const pick = (r: TextRun): Fmt => {
      const o: Fmt = { text: r.text };
      if (r.bold) o.bold = true;
      if (r.italic) o.italic = true;
      if (r.underline) o.underline = true;
      if (r.strike) o.strike = true;
      if (r.script) o.script = r.script;
      if (r.color.toUpperCase() !== "#1D1F24") o.color = r.color.toUpperCase();
      if (r.highlight) o.highlight = r.highlight.toUpperCase();
      // HWPX keeps 자간 as % of the character advance (TextRun.spacingPct): compared as px at the size
      const ls = r.letterSpacing ?? ((r.spacingPct ?? 0) / 100) * r.fontSize;
      if (ls) o.letterSpacing = Math.round(ls);
      if (r.fontFamily !== "Pretendard") o.fontFamily = r.fontFamily;
      return o;
    };
    check(file, "글자 서식(굵게·기울임·밑줄·취소선·위/아래첨자·색·형광펜·자간·글꼴)", fp.runs.map(pick), FORMAT_RUNS);
    check(file, "글자 크기 12pt(16px)", [...new Set(fp.runs.map((r) => Math.round(r.fontSize)))], [BODY]);
  }
  for (const a of ALIGNS) check(file, `정렬 ${a.align}`, find(a.label)?.align, a.align);
  for (const d of INDENTS) {
    const p = find(d.label);
    check(file, `들여쓰기 ${d.label}`, p && [r2(p.indent), r2(p.indentLeft ?? 0)], [d.indent, d.indentLeft]);
  }
  for (const s of SPACINGS) check(file, `줄 간격 ${s}`, r2(find(`줄 간격 ${s.toFixed(1)}배`)?.lineSpacing ?? 0), s);
  for (const t of [...BULLETS.map((t) => `• ${t}`), ...NUMBERED.map((t, i) => `${i + 1}. ${t}`)]) checkTrue(file, `목록 '${t}'`, texts.includes(t));
  check(
    file,
    "목록 역할(실제 번호 매기기에서 다시 읽음)",
    paras.filter((p) => p.role === "li" || p.role === "oli").map((p) => p.role),
    [...BULLETS.map(() => "li"), ...NUMBERED.map(() => "oli")],
  );
  check(file, "표 = 표 개체(4행×3열)", tables.map((t) => t.rows.map((r) => r.map((c) => c.text))), [TABLE_ROWS]);
  check(file, "표 머리글 행", tables.map((t) => t.headerRow), [true]);
  checkTrue(file, "마지막 문단", texts.includes(`문단 ${FILLER}. ${LONG}`));
  checkTrue(file, `오메에서 다시 연 쪽 수 ≥ 3 (${pages})`, pages >= 3, pages);
}

describe("DOCX · HWPX", () => {
  for (const fmt of ["docx", "hwpx"] as const) {
    it(`${fmt}: headings, character formats, 4 alignments, indents, line spacing, lists, table, 3+ pages`, async () => {
      const { doc, paras } = officeDoc(fmt === "docx" ? "오메 Word 호환 시험" : "오메 한글 호환 시험");
      const bytes = await exportVia(fmt, doc, doc.pages[0]);
      const file = fmt === "docx" ? "doc-01-formatting.docx" : "doc-02-formatting.hwpx";
      const ex = officeExpected(paras, fmt);
      add(
        {
          file,
          programs: fmt === "docx" ? ["Word", "한글(참고)"] : ["한글"],
          nature: `오메 문서 → ${fmt.toUpperCase()} 내보내기 (registry '${fmt}')`,
          checks: [
            "열 때 경고·복구 메시지 없음 ('읽을 수 없는 내용', '파일이 손상' 등)",
            fmt === "docx" ? "제목 1·2·3이 스타일(탐색 창/개요)로 잡힘" : "제목 1·2·3이 '개요 1·2·3' 스타일·개요 수준으로 잡힘(개요 번호는 표시 안 함), 크고 굵게 보임",
            "서식 문단: 굵게·기울임·밑줄·취소선·아래첨자(H₂O)·위첨자(x²)·빨간 글자·노란 형광펜(음영)·자간·'맑은 고딕' 글꼴",
            "정렬 4종(왼쪽·가운데·오른쪽·양쪽)",
            "들여쓰기: 첫 줄 24pt / 내어쓰기 18pt+왼쪽 36pt / 왼쪽 48pt (문단 대화상자 값)",
            fmt === "docx" ? "줄 간격: '배수' 값과 실제 줄 높이 기록 (기대값 표 참고: 12pt 글자에서 1.0배 = 12pt, 1.5배 = 18pt, 2.0배 = 24pt 줄 높이)" : "줄 간격: 비율 100% / 150% / 200%",
            fmt === "docx" ? "목록 6줄이 Word 자동 목록(글머리 기호 •, 번호 1. 2. 3.) — 기호·번호를 마우스로 선택할 수 없음" : "목록 6줄이 한글 글머리표(•)·문단 번호(1. 2. 3.) — 기호·번호가 본문 글자가 아님",
            fmt === "docx" ? "표 4행×3열, 테두리, 머리글 행 굵게·음영·'머리글 행 반복'" : "표 4행×3열(한글 표 개체), 실선 테두리, 제목 행 굵게·음영·'제목 줄 자동 반복'",
            "쪽 수 3쪽 이상, 마지막 문단까지 있음",
          ],
          expected: ex,
        },
        bytes,
      );
      const opened = await openVia(fmt, file, bytes);
      verifyOffice(
        file,
        opened.pages!.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs)),
        opened.pages!.flatMap((p) => p.nodes.filter((n): n is import("../src/core/types").TableNode => n.type === "TABLE")),
        fmt,
        opened.pages!.length,
      );
    });
  }
});

// ═════════════════════════════ XLSX · CSV · PPTX ═════════════════════════════

const SALES: TableCell[][] = [
  [{ text: "품목 Item" }, { text: "수량 Qty" }, { text: "단가 Price" }, { text: "금액 Amount" }, { text: "날짜 Date" }],
  [{ text: "사과 Apple" }, { text: "3", align: "RIGHT" }, { text: "1200", align: "RIGHT" }, { text: "3600", formula: "B2*C2", align: "RIGHT" }, { text: "2026-11-11" }],
  [{ text: "배 Pear" }, { text: "5", align: "RIGHT" }, { text: "2500", align: "RIGHT" }, { text: "12500", formula: "B3*C3", align: "RIGHT" }, { text: "2026-11-12" }],
  [{ text: "포도 Grape" }, { text: "2", align: "RIGHT" }, { text: "4000", align: "RIGHT" }, { text: "8000", formula: "B4*C4", align: "RIGHT" }, { text: "2026-12-01" }],
  [{ text: "합계 Total", bold: true }, { text: "10", formula: "SUM(B2:B4)", bold: true, align: "RIGHT" }, { text: "" }, { text: "24100", formula: "SUM(D2:D4)", bold: true, align: "RIGHT" }, { text: "" }],
];
const SALES_W = [130, 80, 90, 110, 110];
const SHEET2: TableCell[][] = [
  [{ text: "Name" }, { text: "Score" }, { text: "Note 비고" }],
  [{ text: "Kim" }, { text: "95", align: "RIGHT" }, { text: "한글 메모" }],
  [{ text: "Lee" }, { text: "88", align: "RIGHT" }, { text: "" }],
  [{ text: "Total x2" }, { text: "48200", formula: "'매출 Sales'!D5*2", align: "RIGHT" }, { text: "다른 시트 참조" }],
];
const SHEET2_W = [100, 80, 160];

const PPT_FMT: Fmt[] = [
  { text: "취소선 Strike", strike: true },
  { text: " x" },
  { text: "2", script: "super" },
  { text: " H" },
  { text: "2", script: "sub" },
  { text: "O " },
  { text: "형광펜 Highlight", highlight: "#FFFF00" },
  { text: " " },
  { text: "자간 Spacing", letterSpacing: 4 },
];

function tablePage(name: string, rows: TableCell[][], widths: number[]): Page {
  const p = newPage("DOCUMENT", 794, 1123, name);
  const t = newTable(rows.map((r) => r.map((c) => ({ ...c }))), widths, name);
  t.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
  p.nodes.push(t);
  return p;
}
const cellsText = (rows: TableCell[][]) => rows.map((r) => r.map((c) => c.text));

describe("XLSX · CSV · PPTX", () => {
  let xlsxBytes: Uint8Array;
  let pptxBytes: Uint8Array;
  let docxBytes: Uint8Array;

  it("xlsx: two sheets, formulas, dates, bold, column widths", async () => {
    const doc = newDocument("오메 Excel 호환 시험");
    doc.pages = [tablePage("매출 Sales", SALES, SALES_W), tablePage("Sheet B 영문", SHEET2, SHEET2_W)];
    xlsxBytes = await exportVia("xlsx", doc, doc.pages[0]);
    const file = "xls-01-two-sheets.xlsx";
    const formulas = [
      ...SALES.flatMap((r, ri) => r.flatMap((c, ci) => (c.formula ? [{ sheet: "매출 Sales", cell: `${"ABCDE"[ci]}${ri + 1}`, formula: "=" + c.formula, cachedValue: c.text }] : []))),
      ...SHEET2.flatMap((r, ri) => r.flatMap((c, ci) => (c.formula ? [{ sheet: "Sheet B 영문", cell: `${"ABC"[ci]}${ri + 1}`, formula: "=" + c.formula, cachedValue: c.text }] : []))),
    ];
    // Excel shows (pixels − 5) ÷ max digit width of the default font (맑은 고딕 11pt = 8px), in steps of 1/8
    const excelWidth = (px: number) => Math.round(((px - 5) / 8) * 8) / 8;
    add(
      {
        file,
        programs: ["Excel", "한셀(참고)"],
        nature: "오메 표 2개 → XLSX 내보내기 (registry 'xlsx')",
        checks: [
          "열 때 경고·복구 메시지 없음",
          "시트 2개: '매출 Sales', 'Sheet B 영문'",
          "수식 입력줄에 수식이 보이고, F9(재계산) 후 값이 기대값과 같음 (다른 시트 참조 포함)",
          "1행(머리글) 굵게·틀 고정, 합계 행 굵게",
          "열 너비: 열 머리글 경계를 끌 때 보이는 '너비' 값 = 기대값 columnWidthsExcelUnits (기본 글꼴 맑은 고딕 11pt의 숫자 폭 8px 기준; 파일에 저장된 width는 여백 5px 포함 = px/8)",
          "날짜 열(E2:E4): 날짜 값(셀 서식 '날짜' yyyy-mm-dd, 오른쪽 정렬), =E3-E2 같은 날짜 계산이 됨",
        ],
        expected: {
          sheets: ["매출 Sales", "Sheet B 영문"],
          cells: { "매출 Sales": cellsText(SALES), "Sheet B 영문": cellsText(SHEET2) },
          formulas,
          boldCells: { "매출 Sales": ["A1", "B1", "C1", "D1", "E1", "A5", "B5", "D5"], "Sheet B 영문": ["A1", "B1", "C1"] },
          frozenHeaderRow: true,
          columnWidthsExcelUnits: { "매출 Sales": SALES_W.map(excelWidth), "Sheet B 영문": SHEET2_W.map(excelWidth) },
          dates: { cells: ["E2", "E3", "E4"], storedAs: "일련번호 숫자 + 날짜 서식(numFmt 'yyyy-mm-dd', 1900 날짜 체계)", serials: [46337, 46338, 46357], values: ["2026-11-11", "2026-11-12", "2026-12-01"] },
        },
      },
      xlsxBytes,
    );
    const opened = await openVia("xlsx", file, xlsxBytes);
    // a workbook opens as sheet grids; its table layout (what printing / sending to a document uses) is checked
    const laid = (await import("../src/io/sheet/pages")).expandSheetPages({ pages: opened.pages! } as import("../src/core/types").OmwDocument).doc.pages;
    const tables = laid.flatMap((p) => p.nodes.filter((n) => n.type === "TABLE")) as import("../src/core/types").TableNode[];
    check(file, "시트 이름", tables.map((t) => t.name), ["매출 Sales", "Sheet B 영문"]);
    check(file, "셀 값", tables.map((t) => cellsText(t.rows)), [cellsText(SALES), cellsText(SHEET2)]);
    check(file, "수식", tables.flatMap((t) => t.rows.flatMap((r) => r.flatMap((c) => (c.formula ? ["=" + c.formula] : [])))), formulas.map((f) => f.formula));
    check(file, "굵게(합계 행)", tables[0].rows[4].map((c) => !!c.bold), [true, true, false, true, false]);
    check(file, "열 너비(px)", tables.map((t) => t.colWidths), [SALES_W, SHEET2_W]);
    const sheet1 = new TextDecoder().decode(unzipSync(xlsxBytes)["xl/worksheets/sheet1.xml"]);
    check(file, "날짜 = 일련번호 숫자", ["E2", "E3", "E4"].map((r) => new RegExp(`<c r="${r}"[^>]*><v>([^<]*)</v>`).exec(sheet1)?.[1]), ["46337", "46338", "46357"]);
    check(file, "날짜 서식", tables[0].rows.slice(1, 4).map((r) => r[4].numFmt), ["yyyy-mm-dd", "yyyy-mm-dd", "yyyy-mm-dd"]);
  });

  it("csv: CP949 (opened, edited, saved in the same encoding) and UTF-8 with BOM", async () => {
    // CP949 file → opened → one cell edited → "save as original type" keeps CP949 without BOM
    const rows = [
      ["이름", "도시", "메모"],
      ["홍길동", "서울", "테스트 Test 한글"],
      ["김철수", "부산", "쉼표, 포함"],
      ["Lee", "Daegu", "따옴표 \"인용\""],
    ];
    const csvText = rows.map((r) => r.map((v) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\r\n") + "\r\n";
    const src = encodeText(csvText, { encoding: "euc-kr" });
    save("csv-01-source-cp949.csv", src, SRC);
    const opened = await openVia("csv", "csv-01-source-cp949.csv", src);
    const doc = docFromOpened(opened, "csv-01");
    const t = doc.pages[0].nodes.find((n) => n.type === "TABLE") as import("../src/core/types").TableNode;
    t.rows[1][2] = { ...t.rows[1][2], text: "고친 셀 Edited" };
    const want = rows.map((r) => [...r]);
    want[1][2] = "고친 셀 Edited";
    const out = await exportVia("csv", doc, doc.pages[0]);
    const file = "csv-01-cp949.csv";
    add(
      {
        file,
        programs: ["Excel", "메모장(인코딩 확인)"],
        nature: "CP949(ANSI) CSV를 오메로 열어 셀 1개 고쳐 '원래 형식으로 저장' — 인코딩·구분자 유지",
        source: "_source/csv-01-source-cp949.csv",
        checks: ["Excel에서 더블클릭으로 열 때 한글이 깨지지 않음", "메모장 오른쪽 아래 인코딩 'ANSI'(BOM 없음)", "쉼표·따옴표가 든 셀이 한 칸으로 들어감", "고친 셀 '고친 셀 Edited'"],
        expected: { encoding: "CP949 (EUC-KR), BOM 없음", lineEnding: "CRLF", delimiter: ",", rows: want },
      },
      out,
    );
    checkTrue(file, "BOM 없음", !(out[0] === 0xef && out[1] === 0xbb && out[2] === 0xbf));
    const back = importCsv(out, file);
    check(file, "다시 연 값", cellsText((back.pages[0].nodes.find((n) => n.type === "TABLE") as import("../src/core/types").TableNode).rows), want);
    check(file, "인코딩 감지", back.pages[0].source?.encoding, "euc-kr");

    // a new table saved as CSV → UTF-8 with BOM (Excel-friendly default)
    const doc2 = newDocument("csv-02");
    doc2.pages = [tablePage("표", rows.map((r) => r.map((text) => ({ text }))), [100, 100, 200])];
    const out2 = await exportVia("csv", doc2, doc2.pages[0]);
    const file2 = "csv-02-utf8-bom.csv";
    add(
      {
        file: file2,
        programs: ["Excel", "메모장(인코딩 확인)"],
        nature: "오메 새 표 → CSV 내보내기 (기본 UTF-8 + BOM)",
        checks: ["Excel에서 더블클릭으로 열 때 한글이 깨지지 않음", "메모장 인코딩 'UTF-8(BOM)'", "쉼표·따옴표가 든 셀이 한 칸으로 들어감"],
        expected: { encoding: "UTF-8 with BOM", lineEnding: "CRLF", delimiter: ",", rows },
      },
      out2,
    );
    check(file2, "BOM", Array.from(out2.subarray(0, 3)), [0xef, 0xbb, 0xbf]);
    const back2 = importCsv(out2, file2);
    check(file2, "다시 연 값", cellsText((back2.pages[0].nodes.find((n) => n.type === "TABLE") as import("../src/core/types").TableNode).rows), rows);
    checkTrue(file2, "CRLF 줄바꿈", new TextDecoder().decode(out2).includes("\r\n"));
  });

  it("pptx: text, shapes, picture, table, three slides", async () => {
    const doc = newDocument("오메 PowerPoint 호환 시험");
    const img = makeAsset(pngOf(200, 150, (x, y) => (Math.hypot(x - 100, y - 75) < 60 ? [240, 180, 20, 255] : [30 + x / 2, 80, 160 + y / 2, 255])), "image/png", "picture.png");
    doc.assets[img.id] = img;
    const s1 = newPage("SLIDE", 1280, 720, "슬라이드 1");
    s1.transition = { type: "NONE", duration: 400 }; // only slide 2 has a transition
    const title = textNode(`슬라이드 1 제목 — ${KO_EN}`, 80, 60, 1100, { fontSize: 44, bold: true });
    const sub = textNode("굵게 아님 본문 Body text", 80, 160, 900, { fontSize: 24 });
    sub.paragraphs.push(newParagraph("빨간 기울임 Red italic", { fontSize: 24, italic: true, color: "#c00000" }));
    const fp = newParagraph("", { fontSize: 24 });
    const fr = fp.runs[0];
    fp.runs = PPT_FMT.map(({ text, ...f }) => ({ ...fr, ...f, text }));
    sub.paragraphs.push(fp);
    const rect = newVector([rectContour(80, 320, 360, 220)], "파란 사각형");
    rect.fill = "#2f6fdf";
    rect.stroke = "#000000";
    rect.strokeWidth = 4;
    const ell = newVector([ellipseContour(800, 430, 180, 110)], "주황 타원");
    ell.fill = "#f08020";
    s1.nodes.push(title, sub, rect, ell);
    const s2 = newPage("SLIDE", 1280, 720, "슬라이드 2");
    s2.background = "#f3f6ff";
    s2.transition = { type: "FADE", duration: 400 };
    const pic = newImage(img.id, 400, 300, "그림 Picture");
    pic.transform = { x: 440, y: 200, rotation: 0, scale: 1 };
    s2.nodes.push(textNode(`슬라이드 2 그림 — ${KO_EN}`, 80, 60, 1100, { fontSize: 40, bold: true }), pic);
    const s3 = newPage("SLIDE", 1280, 720, "슬라이드 3");
    s3.transition = { type: "NONE", duration: 400 };
    const tbl = newTable(TABLE_ROWS, [300, 160, 300], "슬라이드 표");
    tbl.fontSize = 22;
    tbl.transform = { x: 80, y: 180, rotation: 0, scale: 1 };
    s3.nodes.push(textNode(`슬라이드 3 표 — ${KO_EN}`, 80, 60, 1100, { fontSize: 40, bold: true }), tbl);
    doc.pages = [s1, s2, s3];
    pptxBytes = await exportVia("pptx", doc, s1);
    const file = "ppt-01-slides.pptx";
    const slideTexts = [
      [`슬라이드 1 제목 — ${KO_EN}`, "굵게 아님 본문 Body text", "빨간 기울임 Red italic", PPT_FMT.map((f) => f.text).join("")],
      [`슬라이드 2 그림 — ${KO_EN}`],
      [`슬라이드 3 표 — ${KO_EN}`, ...TABLE_ROWS.flat()],
    ];
    add(
      {
        file,
        programs: ["PowerPoint", "한쇼(참고)"],
        nature: "오메 슬라이드 3장 → PPTX 내보내기 (registry 'pptx')",
        checks: ["열 때 '복구' 메시지 없음", "슬라이드 3장, 16:9 (33.867×19.05cm)", "1장: 제목·본문(빨간 기울임 포함) 텍스트 상자 편집 가능, 파란 사각형(검정 테두리)·주황 타원이 도형(점 편집 가능)", "1장 서식 줄: 취소선, x²(위 첨자), H₂O(아래 첨자), 노란 형광펜(PowerPoint 2019 이상), 자간 넓게(글꼴 대화상자 '문자 간격' 확대 3pt)", "2장: 배경 연한 파랑, 그림 1개(400×300px 크기), 페이드 전환", "3장: 표 4행×3열(PowerPoint 표로 편집 가능)", "슬라이드 쇼 실행 정상"],
        expected: { slides: 3, slideSizeEmu: [12192000, 6858000], textPerSlide: slideTexts, formatRunsSlide1: PPT_FMT.filter((f) => f.text.trim()), shapesSlide1: ["파란 사각형 (#2F6FDF, 테두리 #000000)", "주황 타원 (#F08020)"], picturesSlide2: 1, tableSlide3: { rows: 4, cols: 3, cells: TABLE_ROWS }, transitionSlide2: "fade", backgroundSlide2: "#F3F6FF" },
      },
      pptxBytes,
    );
    const opened = await openVia("pptx", file, pptxBytes);
    check(file, "슬라이드 수", opened.pages!.length, 3);
    const texts = opened.pages!.map((p) =>
      p.nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs.map(paraText) : n.type === "TABLE" ? n.rows.flat().map((c) => c.text) : [])),
    );
    slideTexts.forEach((ts, i) => ts.forEach((s) => checkTrue(file, `${i + 1}장 텍스트 '${s}'`, texts[i].includes(s))));
    check(file, "1장 도형 채움색", opened.pages![0].nodes.filter((n): n is VectorNode => n.type === "VECTOR").map((n) => n.fill?.toLowerCase()), ["#2f6fdf", "#f08020"]);
    check(file, "전환(1·3장 없음, 2장 페이드)", opened.pages!.map((p) => p.transition.type), ["NONE", "FADE", "NONE"]);
    check(file, "2장 그림 수", opened.pages![1].nodes.filter((n) => n.type === "IMAGE").length, 1);
    check(file, "3장 표 크기", opened.pages![2].nodes.filter((n) => n.type === "TABLE").map((n) => (n.type === "TABLE" ? [n.rows.length, n.colWidths.length] : [])), [[4, 3]]);
    check(file, "가져오기 근사·생략 경고", opened.warnings ?? [], []);
    const fpBack = opened.pages![0].nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs : [])).find((p) => paraText(p) === PPT_FMT.map((f) => f.text).join(""));
    check(
      file,
      "1장 글자 서식(취소선·위/아래첨자·형광펜·자간)",
      fpBack?.runs.map((r) => ({ text: r.text, ...(r.strike ? { strike: true } : {}), ...(r.script ? { script: r.script } : {}), ...(r.highlight ? { highlight: r.highlight.toUpperCase() } : {}), ...(r.letterSpacing ? { letterSpacing: Math.round(r.letterSpacing) } : {}) })),
      PPT_FMT,
    );
  });

  it("encrypted Office: DOCX / XLSX / PPTX with the test password", async () => {
    const { doc } = officeDoc("오메 암호 Word 시험");
    docxBytes = await exportVia("docx", doc, doc.pages[0]);
    for (const [ext, plain, program, what] of [
      ["docx", docxBytes, "Word", "doc-01과 같은 구성의 Word 문서"],
      ["xlsx", xlsxBytes, "Excel", "xls-01과 같은 통합 문서"],
      ["pptx", pptxBytes, "PowerPoint", "ppt-01과 같은 슬라이드"],
    ] as const) {
      const enc = await encryptOffice(plain, PW);
      const file = `enc-${ext}-agile-aes256.${ext}`;
      add(
        {
          file,
          programs: [program],
          password: PW,
          nature: `${what}를 오메의 'Office 암호'(ECMA-376 Agile, AES-256/SHA-512)로 암호화`,
          checks: ["열 때 암호 입력 창이 뜸 · 틀린 암호 거부", `암호 '${PW}'로 열림, 경고·복구 메시지 없음`, `내용이 ${ext === "docx" ? "doc-01" : ext === "xlsx" ? "xls-01" : "ppt-01"}과 같음`, "파일 → 정보: '이 문서를 열려면 암호가 필요합니다'", "암호 해제 후 저장 → 다시 열기 정상"],
          expected: { encryption: "ECMA-376 Agile Encryption (AES-256, SHA-512)", container: "OLE 복합 파일(CFB)", password: PW, content: ext === "docx" ? "doc-01-formatting.docx와 같은 구성" : ext === "xlsx" ? "xls-01-two-sheets.xlsx와 같음" : "ppt-01-slides.pptx와 같음" },
        },
        enc,
      );
      checkTrue(file, "암호 Office 파일로 인식", isEncryptedOffice(enc));
      checkTrue(file, "암호로 풀면 원래 바이트", bytesEq(await decryptOffice(enc, PW), plain));
      let refused = false;
      try {
        await decryptOffice(enc, "wrong-password");
      } catch {
        refused = true;
      }
      checkTrue(file, "틀린 암호 거부", refused);
      const opened = await openVia(ext, file, await decryptOffice(enc, PW));
      checkTrue(file, "풀어서 오메로 열림", (opened.pages?.length ?? 0) > 0);
    }
  });
});

// ═════════════════════════════ expected.json · CHECKLIST.md ═════════════════════════════

function md(v: unknown): string {
  return "`" + JSON.stringify(v).replace(/`/g, "'") + "`";
}
function expectedLines(e: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) continue;
    if (k === "layersBottomToTop" && Array.isArray(v)) {
      out.push(`- **레이어 (Photoshop 레이어 패널 위→아래 순서)**`, "", "  | # | 이름 | 혼합 모드 | 불투명도 | 보임 | 잠금 | 경계 [왼,위,오른,아래] px |", "  |---|---|---|---|---|---|---|");
      [...v].reverse().forEach((l: any, i: number) => out.push(`  | ${i + 1} | ${l.name} | ${l.blendUI} | ${l.opacityPct}% | ${l.visible ? "예" : "숨김"} | ${l.locked ? "잠금" : "-"} | ${l.bounds.join(", ")} |`));
      out.push("");
    } else if (k === "textPerPage" && Array.isArray(v)) {
      out.push(`- **쪽별 텍스트**`);
      v.forEach((t: string[], i: number) => out.push(`  - ${i + 1}쪽: ${t.map((s) => "「" + s + "」").join(" ")}`));
    } else if (k === "textPerSlide" && Array.isArray(v)) {
      out.push(`- **슬라이드별 텍스트**`);
      v.forEach((t: string[], i: number) => out.push(`  - ${i + 1}장: ${t.map((s) => "「" + s + "」").join(" ")}`));
    } else if (k === "formatRuns" && Array.isArray(v)) {
      out.push(`- **서식 문단 (글자 단위)**`, "", "  | 글자 | 서식 |", "  |---|---|");
      v.forEach((f: any) => {
        const { text, sizePt, ...rest } = f;
        out.push(`  | ${text} | ${Object.entries(rest).map(([a, b]) => (b === true ? a : `${a}=${b}`)).join(", ") || "보통"} · ${sizePt}pt |`);
      });
      out.push("");
    } else if (k === "cells" && v && typeof v === "object" && !Array.isArray(v)) {
      for (const [sheet, rows] of Object.entries(v as Record<string, string[][]>)) {
        out.push(`- **시트 '${sheet}' 값**`, "", `  | ${rows[0].map((_, i) => "ABCDE"[i]).join(" | ")} |`, `  |${rows[0].map(() => "---").join("|")}|`);
        rows.forEach((r) => out.push(`  | ${r.map((c) => c || " ").join(" | ")} |`));
        out.push("");
      }
    } else out.push(`- **${k}**: ${md(v)}`);
  }
  return out;
}

const fmtSize = (n: number) => (n >= MB ? `${(n / MB).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

describe("kit index", () => {
  it("writes expected.json and CHECKLIST.md; sizes within limits", () => {
    const total = KIT.reduce((a, e) => a + (e.bytes ?? 0), 0);
    expect(total, "total ≤ 30MB").toBeLessThanOrEqual(30 * MB);
    const selfFailed = Object.entries(SELF).flatMap(([f, cs]) => cs.filter((c) => !c.ok).map((c) => `${f}: ${c.what}`));
    const json = {
      generator: "scripts/make-interop-kit.test.ts",
      run: "npx vitest run scripts/make-interop-kit.test.ts --dir scripts",
      generatedAt: new Date().toISOString().slice(0, 10),
      testPassword: PW,
      totalBytes: total,
      selfCheckFailures: selfFailed,
      generatorDefects: DEFECTS,
      files: Object.fromEntries(KIT.map((e) => [e.file, { programs: e.programs, nature: e.nature, password: e.password, source: e.source, bytes: e.bytes, checks: e.checks, expected: e.expected, selfCheck: SELF[e.file] ?? [] }])),
    };
    fs.writeFileSync(`${OUT}/expected.json`, JSON.stringify(json, null, 2) + "\n");

    const L: string[] = [];
    L.push(
      "# 호환 시험 체크리스트 — 오메가 저장한 파일을 실제 프로그램으로 열기",
      "",
      "> 이 파일은 `scripts/make-interop-kit.test.ts`가 자동으로 만듭니다 (직접 고치지 말고 생성기를 고친 뒤 다시 실행).",
      "> 실행: `OMW_INTEROP_KIT=1 npx vitest run scripts/make-interop-kit.test.ts --dir scripts` (PowerShell: `$env:OMW_INTEROP_KIT=1; npx vitest run …`; 변수 없이 돌리면 임시 폴더에만 만들고 지움) · 파일: `qa/interop/omniweave-made/` · 자동 비교용 기대값: `omniweave-made/expected.json`",
      "",
      `- 시험 암호: \`${PW}\` (시험 전용)`,
      "- 내용은 모두 생성기가 코드로 만든 시험용 도형·글자(`테스트 Test 한글`)이며 개인 파일은 없습니다.",
      "- `_source/` 폴더는 오메가 **연** 입력(참고·비교용)입니다. 시험 대상은 `omniweave-made/` 바로 아래 파일입니다.",
      `- 오메 자체 재열기 검증(자기 검증): ${selfFailed.length ? `**실패 ${selfFailed.length}건** — expected.json의 selfCheckFailures 참고` : "모든 파일 통과"}`,
      ...(DEFECTS.length ? ["", "**생성기가 찾은 오메 결함 (실제 프로그램에서도 그렇게 보이는 것이 '정상 재현'입니다)**", "", ...DEFECTS.map((d) => `- ${d}`)] : []),
      "",
      "## 공통 기록 방법",
      "",
      "1. 파일을 **더블클릭이 아니라 각 프로그램의 '열기'**로 엽니다(연결 프로그램 차이 제거). 버전(예: Photoshop 2025 26.x)을 적습니다.",
      "2. **열 때 경고·복구·오류 대화상자가 하나도 없어야** 합니다. 뜨면 문구를 그대로 적고 스크린샷을 남깁니다.",
      "3. 확인 항목마다 기대값과 비교해 ✅ / ⚠️(다르지만 쓸 만함) / ❌(깨짐)을 표시합니다.",
      "4. PDF·AI는 Acrobat Pro **프리플라이트 → 'PDF 구문 문제 보고'(Report PDF syntax issues)** 결과를 적습니다.",
      "5. 결과는 `qa/interop/RESULTS-YYYY-MM-DD.md`에 아래 '결과 기록' 표를 복사해 채웁니다.",
      "",
      "## 파일 목록",
      "",
      "| 파일 | 크기 | 열 프로그램 | 암호 | 성격 |",
      "|---|---|---|---|---|",
      ...KIT.map((e) => `| \`${e.file}\` | ${fmtSize(e.bytes ?? 0)} | ${e.programs.join(", ")} | ${e.password ? "있음" : "-"} | ${e.nature.split(" (")[0].split(" — ")[0]} |`),
      "",
      `합계 ${fmtSize(total)} · ${KIT.length}개 파일`,
      "",
    );
    for (const e of KIT) {
      L.push(`## \`${e.file}\``, "", `- **열 프로그램**: ${e.programs.join(", ")}`, `- **성격**: ${e.nature}`);
      if (e.password) L.push(`- **암호**: \`${e.password}\``);
      if (e.source) L.push(`- **원본(비교용)**: \`${e.source}\``);
      const self = SELF[e.file] ?? [];
      const bad = self.filter((c) => !c.ok);
      L.push(`- **오메 자기 검증**: ${bad.length ? `❌ ${bad.length}/${self.length} 실패 — ${bad.map((c) => c.what).join("; ")}` : `✅ ${self.length}개 항목 통과`}`, "", "**확인 항목**", "");
      e.checks.forEach((c) => L.push(`- [ ] ${c}`));
      L.push("", "**기대값** (생성기가 실제로 넣은 값)", "", ...expectedLines(e.expected), "", "**결과 기록**", "", "| 프로그램·버전 | 열림(경고 없음) | 문제 | 스크린샷 |", "|---|---|---|---|");
      e.programs.forEach((p) => L.push(`| ${p} |  |  |  |`));
      L.push("");
    }
    fs.writeFileSync(`${ROOT}/CHECKLIST.md`, L.join("\n"));
    console.log(`interop kit: ${KIT.length} files, ${fmtSize(total)}; self-check failures: ${selfFailed.length}`);
    for (const e of KIT) console.log(`  ${e.file}  ${fmtSize(e.bytes ?? 0)}`);
    for (const f of selfFailed) console.log(`  SELF-CHECK FAIL ${f}`);
    for (const d of DEFECTS) console.log(`  DEFECT ${d}`);
  });
});
