// Shared helpers for PDF Surgeon tests. Corpus files are only read by path (never copied).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { computeO, computeU, legacyFileKey, objectKey, padPassword, rc4, aesEncryptPdf, type SecurityParams } from "../../src/io/pdfsurgeon/crypto";
import { PdfDict, PdfRef, PdfStr, serialize, type PdfVal } from "../../src/io/pdfsurgeon/syntax";
import { scanObjects } from "../../src/io/pdfsurgeon/decrypt";


import { setCMapLoader } from "../../src/io/pdfsurgeon/bcmap";

export const ROOT = process.cwd();
// the app bundles these from pdfjs-dist; tests read them from node_modules
setCMapLoader(async (name) => {
  const p = join(ROOT, "node_modules/pdfjs-dist/cmaps", `${name}.bcmap`);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
});
export const FONT = readFileSync(join(ROOT, "assets/fonts/Pretendard-Regular.ttf"));
export const fallbackFont = async () => new Uint8Array(FONT);

let pdfjsMod: any;
export async function pdfjs() {
  if (!pdfjsMod) {
    pdfjsMod = await import("pdfjs-dist");
    pdfjsMod.GlobalWorkerOptions.workerSrc = pathToFileURL(join(ROOT, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs")).href;
  }
  return pdfjsMod;
}

export async function openJs(bytes: Uint8Array, password?: string) {
  const p = await pdfjs();
  return p.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, password, cMapUrl: join(ROOT, "node_modules/pdfjs-dist/cmaps") + "/", cMapPacked: true, standardFontDataUrl: join(ROOT, "node_modules/pdfjs-dist/standard_fonts") + "/" }).promise;
}

/** Text items of a page as pdf.js extracts them (string + font name). */
export async function pageText(doc: any, i: number): Promise<{ str: string; font: string }[]> {
  const page = await doc.getPage(i + 1);
  const tc = await page.getTextContent();
  return tc.items.filter((it: any) => it.str && it.str.trim()).map((it: any) => ({ str: it.str, font: tc.styles[it.fontName]?.fontFamily ?? it.fontName }));
}

/** Operator list of a page (names + JSON args), the render-level comparison used without a canvas. */
export async function opList(doc: any, i: number): Promise<string[]> {
  const p = await pdfjs();
  const names = new Map<number, string>(Object.entries(p.OPS).map(([k, v]) => [v as number, k]));
  const page = await doc.getPage(i + 1);
  const ol = await page.getOperatorList();
  // font ids embed the pdf.js document number ("g_d9_f1"): normalise them so two documents compare
  const norm = (_key: string, v: unknown) => (v instanceof Uint8Array || v instanceof Uint8ClampedArray ? Array.from(v.subarray(0, 64)) : typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
  // pdf.js numbers fonts per document load order: rename them by first use on this page
  const fontIds = new Map<string, string>();
  return ol.fnArray.map((fn: number, k: number) => {
    const args = JSON.stringify(ol.argsArray[k], norm) ?? "";
    return `${names.get(fn)}${args.replace(/g_d\d+_f\d+/g, (id) => fontIds.get(id) ?? (fontIds.set(id, `font${fontIds.size}`), fontIds.get(id)!))}`;
  });
}

/** Corpus PDF/AI files (personal: read by path only). Empty when the folder is absent. */
export function corpusFiles(exts: string[]): string[] {
  const out: string[] = [];
  for (const dir of ["pdf", "etc", "images"]) {
    const d = join(ROOT, "test-corpus", dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) if (exts.some((e) => f.toLowerCase().endsWith(e))) out.push(join(d, f));
  }
  return out;
}

/** A three-page sample: Helvetica lines, an embedded CID font line, rectangles. */
export async function samplePdf(opts: { objectStreams?: boolean } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const ko = await doc.embedFont(FONT, { subset: true });
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 20, y: 20, width: 120, height: 60, color: rgb(1, 0, 0) });
    page.drawRectangle({ x: 200, y: 20, width: 100, height: 50, color: rgb(0, 0, 1), borderColor: rgb(0, 0.5, 0), borderWidth: 2 });
    page.drawText(`Page ${p + 1} first line`, { x: 30, y: 250, size: 14, font: helv, color: rgb(0.1, 0.2, 0.3) });
    page.drawText("Second line stays", { x: 30, y: 220, size: 12, font: helv });
    page.drawText("한글 문장 둘째 글꼴", { x: 30, y: 190, size: 12, font: ko });
  }
  return doc.save({ useObjectStreams: opts.objectStreams ?? false });
}

// ───────── legacy encryption for fixtures (RC4 40/128, AES-128) ─────────

export async function encryptLegacy(input: Uint8Array, userPw: string, ownerPw: string, kind: "rc4-40" | "rc4-128" | "aes-128"): Promise<Uint8Array> {
  // normalise first: pdf-lib writes a classic file without object streams
  const plain = await (await PDFDocument.load(input)).save({ useObjectStreams: false });
  const { objs, trailers } = scanObjects(plain);
  const trailer = trailers[trailers.length - 1];
  const id0 = new Uint8Array(16).map((_, i) => (i * 37 + 11) & 255);
  const R = kind === "rc4-40" ? 2 : kind === "rc4-128" ? 3 : 4;
  const V = kind === "rc4-40" ? 1 : kind === "rc4-128" ? 2 : 4;
  const keyLen = kind === "rc4-40" ? 5 : 16;
  const P = -4;
  const base = { V, R, keyLen, P, id0, encryptMetadata: true };
  const O = computeO(base, ownerPw, userPw);
  const sp: SecurityParams = { ...base, O, U: new Uint8Array(32) };
  const key = legacyFileKey(sp, padPassword(userPw));
  const U = computeU(sp, key);
  const aes = kind === "aes-128";
  const encBytes = async (data: Uint8Array, num: number, gen: number) => {
    const k = objectKey(key, num, gen, aes);
    return aes ? aesEncryptPdf(k, data) : rc4(k, data);
  };
  const walk = async (v: PdfVal, num: number, gen: number): Promise<PdfVal> => {
    if (v instanceof PdfStr) return new PdfStr(await encBytes(v.bytes, num, gen), true);
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, num, gen)));
    if (v instanceof PdfDict) {
      const d = new PdfDict();
      for (const [k, x] of v.map) d.map.set(k, await walk(x, num, gen));
      return d;
    }
    return v;
  };
  const chunks: Uint8Array[] = [];
  let size = 0;
  const push = (b: Uint8Array) => (chunks.push(b), (size += b.length));
  const ascii = (s: string) => push(Uint8Array.from(s, (c) => c.charCodeAt(0) & 255));
  ascii("%PDF-1.6\n");
  const offsets: [number, number][] = [];
  let maxNum = 0;
  for (const o of objs.values()) {
    offsets.push([o.num, size]);
    maxNum = Math.max(maxNum, o.num);
    const value = await walk(o.value, o.num, o.gen);
    if (o.stream && value instanceof PdfDict) {
      const data = await encBytes(o.stream, o.num, o.gen);
      value.map.set("Length", data.length);
      ascii(`${o.num} ${o.gen} obj\n${serialize(value)}\nstream\n`);
      push(data);
      ascii("\nendstream\nendobj\n");
    } else ascii(`${o.num} ${o.gen} obj\n${serialize(value)}\nendobj\n`);
  }
  const encNum = maxNum + 1;
  offsets.push([encNum, size]);
  const cf = aes ? "/CF << /StdCF << /CFM /AESV2 /Length 16 /AuthEvent /DocOpen >> >> /StmF /StdCF /StrF /StdCF" : "";
  ascii(`${encNum} 0 obj\n<< /Filter /Standard /V ${V} /R ${R} /Length ${keyLen * 8} /P ${P} /O ${serialize(new PdfStr(O, true))} /U ${serialize(new PdfStr(U, true))} ${cf} >>\nendobj\n`);
  const xrefAt = size;
  offsets.sort((a, b) => a[0] - b[0]);
  let x = `xref\n0 ${encNum + 1}\n0000000000 65535 f\r\n`;
  const map = new Map(offsets);
  for (let i = 1; i <= encNum; i++) x += map.has(i) ? `${String(map.get(i)).padStart(10, "0")} 00000 n\r\n` : "0000000000 00001 f\r\n";
  const root = trailer.get("Root") as PdfRef;
  ascii(`${x}trailer\n<< /Size ${encNum + 1} /Root ${root.num} ${root.gen} R /Encrypt ${encNum} 0 R /ID [${serialize(new PdfStr(id0, true))} ${serialize(new PdfStr(id0, true))}] >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  return out;
}


