// PDF Surgeon — incremental update writer (ISO 32000-1 §7.5.6).
// The original bytes are copied unchanged; changed and new objects are appended after them with a
// cross-reference section whose /Prev points at the original one. The section uses the same kind
// (table or stream) as the file's last cross-reference section.

import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFContext, type PDFObject } from "pdf-lib";
import { t } from "../../i18n";
import { latin1 } from "./syntax";

const enc = new TextEncoder();

export interface XrefInfo {
  startxref: number;
  stream: boolean;
  size: number;
}

/** Locate the last cross-reference section and the trailer /Size. Throws when the file has none. */
export function lastXref(bytes: Uint8Array): XrefInfo {
  const tail = latin1(bytes, Math.max(0, bytes.length - 2048));
  const m = [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error(t("engine.pdf.noStartxref"));
  const at = +m[1];
  if (at <= 0 || at >= bytes.length) throw new Error(t("engine.pdf.badStartxref"));
  const head = latin1(bytes, at, Math.min(bytes.length, at + 64));
  const stream = !/^\s*xref/.test(head);
  // /Size of the newest trailer (classic: after the table; stream: in the xref stream dictionary)
  const region = latin1(bytes, at, Math.min(bytes.length, at + 8 * 1024 * 1024));
  const sm = /\/Size\s+(\d+)/.exec(region);
  return { startxref: at, stream, size: sm ? +sm[1] : 0 };
}

function objectBytes(obj: PDFObject): Uint8Array {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
}

/** Make sure new refs from `ctx.nextRef()` are above every object number the file already uses. */
export function reserveNumbers(ctx: PDFContext, size: number) {
  if (ctx.largestObjectNumber < size - 1) ctx.largestObjectNumber = size - 1;
}

export function writeIncremental(base: Uint8Array, ctx: PDFContext, refs: PDFRef[]): Uint8Array {
  const xr = lastXref(base);
  const parts: Uint8Array[] = [base];
  let size = base.length;
  const push = (b: Uint8Array) => (parts.push(b), (size += b.length));
  if (base[base.length - 1] !== 10 && base[base.length - 1] !== 13) push(enc.encode("\n"));
  const entries: { num: number; gen: number; off: number }[] = [];
  const uniq = new Map<string, PDFRef>();
  for (const r of refs) uniq.set(`${r.objectNumber} ${r.generationNumber}`, r);
  const sorted = [...uniq.values()].sort((a, b) => a.objectNumber - b.objectNumber);
  for (const r of sorted) {
    const obj = ctx.lookup(r);
    if (!obj) continue;
    entries.push({ num: r.objectNumber, gen: r.generationNumber, off: size });
    push(enc.encode(`${r.objectNumber} ${r.generationNumber} obj\n`));
    push(objectBytes(obj));
    push(enc.encode("\nendobj\n"));
  }
  const maxNum = Math.max(xr.size - 1, ctx.largestObjectNumber, ...entries.map((e) => e.num));
  const t = ctx.trailerInfo;
  const trailerParts: string[] = [];
  if (t.Root) trailerParts.push(`/Root ${t.Root.toString()}`);
  if (t.Info) trailerParts.push(`/Info ${t.Info.toString()}`);
  if (t.ID) trailerParts.push(`/ID ${t.ID.toString()}`);
  trailerParts.push(`/Prev ${xr.startxref}`);
  if (xr.stream) {
    const num = maxNum + 1;
    const all = [...entries, { num, gen: 0, off: size }].sort((a, b) => a.num - b.num);
    const { index, rows } = sections(all);
    const data = new Uint8Array(rows.length * 7);
    rows.forEach((e, i) => {
      const o = i * 7;
      data[o] = 1;
      data[o + 1] = (e.off >>> 24) & 255;
      data[o + 2] = (e.off >>> 16) & 255;
      data[o + 3] = (e.off >>> 8) & 255;
      data[o + 4] = e.off & 255;
      data[o + 5] = (e.gen >>> 8) & 255;
      data[o + 6] = e.gen & 255;
    });
    const at = size;
    push(enc.encode(`${num} 0 obj\n<< /Type /XRef /Size ${num + 1} /W [1 4 2] /Index [${index.join(" ")}] /Length ${data.length} ${trailerParts.join(" ")} >>\nstream\n`));
    push(data);
    push(enc.encode(`\nendstream\nendobj\nstartxref\n${at}\n%%EOF\n`));
  } else {
    const at = size;
    const { groups } = sectionsGrouped(entries);
    let x = "xref\n";
    for (const g of groups) {
      x += `${g[0].num} ${g.length}\n`;
      for (const e of g) x += `${String(e.off).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
    }
    push(enc.encode(`${x}trailer\n<< /Size ${maxNum + 1} ${trailerParts.join(" ")} >>\nstartxref\n${at}\n%%EOF\n`));
  }
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/**
 * Write the whole file again (no incremental section): only objects reachable from the trailer's /Root and /Info
 * are written, so objects that are no longer referenced (for example Illustrator private data that was removed or
 * replaced) leave the file. Object numbers are kept; a classic cross-reference table with a proper free list.
 */
export function writeFull(base: Uint8Array, ctx: PDFContext): Uint8Array {
  const tr = ctx.trailerInfo;
  const seen = new Map<string, PDFRef>();
  const stack: PDFObject[] = [];
  const visit = (o: PDFObject | undefined) => {
    if (o) stack.push(o);
  };
  visit(tr.Root);
  visit(tr.Info);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const k = `${o.objectNumber} ${o.generationNumber}`;
      if (seen.has(k)) continue;
      const target = ctx.lookup(o);
      if (!target) continue;
      seen.set(k, o);
      visit(target);
    } else if (o instanceof PDFDict) for (const [, v] of o.entries()) visit(v);
    else if (o instanceof PDFArray) for (let i = 0; i < o.size(); i++) visit(o.get(i));
    else if (o instanceof PDFStream) visit(o.dict);
  }
  const head = latin1(base, 0, Math.min(base.length, 32));
  const ver = /^%PDF-\d\.\d/.exec(head)?.[0] ?? "%PDF-1.7";
  const parts: Uint8Array[] = [enc.encode(ver + "\n%"), Uint8Array.of(0xe2, 0xe3, 0xcf, 0xd3, 10)];
  let size = parts.reduce((n, p) => n + p.length, 0);
  const push = (b: Uint8Array) => (parts.push(b), (size += b.length));
  const refs = [...seen.values()].sort((a, b) => a.objectNumber - b.objectNumber);
  const offs = new Map<number, { off: number; gen: number }>();
  for (const r of refs) {
    offs.set(r.objectNumber, { off: size, gen: r.generationNumber });
    push(enc.encode(`${r.objectNumber} ${r.generationNumber} obj\n`));
    push(objectBytes(ctx.lookup(r)!));
    push(enc.encode("\nendobj\n"));
  }
  const max = refs.length ? refs[refs.length - 1].objectNumber : 0;
  const free: number[] = [];
  for (let n = 1; n <= max; n++) if (!offs.has(n)) free.push(n);
  let x = `xref\n0 ${max + 1}\n${String(free[0] ?? 0).padStart(10, "0")} 65535 f\r\n`;
  let fi = 0;
  for (let n = 1; n <= max; n++) {
    const e = offs.get(n);
    if (e) x += `${String(e.off).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
    else x += `${String(free[++fi] ?? 0).padStart(10, "0")} 00001 f\r\n`;
  }
  const tp: string[] = [`/Size ${max + 1}`];
  if (tr.Root) tp.push(`/Root ${tr.Root.toString()}`);
  if (tr.Info) tp.push(`/Info ${tr.Info.toString()}`);
  if (tr.ID) tp.push(`/ID ${tr.ID.toString()}`);
  const at = size;
  push(enc.encode(`${x}trailer\n<< ${tp.join(" ")} >>\nstartxref\n${at}\n%%EOF\n`));
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

type Entry = { num: number; gen: number; off: number };

function sectionsGrouped(entries: Entry[]): { groups: Entry[][] } {
  const groups: Entry[][] = [];
  for (const e of entries) {
    const g = groups[groups.length - 1];
    if (g && g[g.length - 1].num + 1 === e.num) g.push(e);
    else groups.push([e]);
  }
  return { groups };
}

function sections(entries: Entry[]): { index: number[]; rows: Entry[] } {
  const { groups } = sectionsGrouped(entries);
  return { index: groups.flatMap((g) => [g[0].num, g.length]), rows: groups.flat() };
}

/** Shallow copy of a dictionary registered nowhere (for copy-on-write of shared dictionaries). */
export function cloneDict(ctx: PDFContext, d: PDFDict): PDFDict {
  const out = ctx.obj({}) as PDFDict;
  for (const [k, v] of d.entries()) out.set(k, v);
  return out;
}
