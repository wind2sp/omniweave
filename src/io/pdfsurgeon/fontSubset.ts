// PDF Surgeon — font subsetting for "용량 줄이기" (Acrobat's PDF optimizer ▸ 글꼴: unembed / subset).
//
// A composite TrueType font (Type0 / CIDFontType2, Identity-H/V, CIDToGIDMap Identity) embedded WHOLE — a Korean
// font of several megabytes for a page of text — is cut down to the glyphs the file shows. Its codes stay the same:
// the new CIDToGIDMap maps each code (CID) to the glyph's number in the subset, so no content stream changes. The
// widths (/W, by CID) and /ToUnicode stay as they are. Glyphs used anywhere count: page content, forms, tiling
// patterns, annotation appearances; a font the form fields may type with (AcroForm /DR) is left whole.

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFContext } from "pdf-lib";
import { padTtfSubsetGlyphs } from "../fontkitPatch";
import { analyzePage } from "./interpret";
import { dget, dictOf, hiddenOcgs, look, nameOf, openSurgeonDoc, pageContent, pageResources, streamBytes, type SurgeonDoc } from "./document";
import { I } from "./matrix";
import { savePdf } from "./acrobat";

export interface SubsetReport {
  /** fonts made into subsets */
  fonts: { name: string; before: number; after: number; glyphs: number }[];
  saved: number;
}

const TAG = () => Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("");

/** Every font use of the file: content of each page, its forms, the tiling patterns and annotation appearances. */
function collectUse(sd: SurgeonDoc) {
  const hidden = hiddenOcgs(sd);
  const run = (res: PDFDict | undefined, bytes: Uint8Array) => {
    try {
      analyzePage(sd, I, res, bytes, hidden);
    } catch {
      /* a stream that cannot be read is not counted: its fonts stay whole (see `unreadFonts`) */
    }
  };
  const ctx = sd.ctx;
  for (let i = 0; i < sd.pageRefs.length; i++) {
    run(pageResources(sd, i), pageContent(sd, i));
  }
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFStream)) continue;
    const type = nameOf(o.dict.get(PDFName.of("Type")));
    const sub = nameOf(o.dict.get(PDFName.of("Subtype")));
    // tiling patterns and form XObjects not drawn from a page (annotation appearances, unused forms)
    if ((type === "Pattern" && (o.dict.get(PDFName.of("PatternType")) as PDFNumber | undefined)?.asNumber?.() === 1) || sub === "Form") {
      try {
        run(dictOf(dget(ctx, o.dict, "Resources")), streamBytes(ctx, o));
      } catch {
        /* undecodable */
      }
    }
  }
}

/** Fonts listed in the form's default resources: fields may type any character with them. */
function formFonts(ctx: PDFContext, catalog: PDFDict): Set<string> {
  const out = new Set<string>();
  const af = dictOf(dget(ctx, catalog, "AcroForm"));
  const fonts = dictOf(dget(ctx, dictOf(dget(ctx, af, "DR")), "Font"));
  if (fonts) for (const [, r] of fonts.entries()) if (r instanceof PDFRef) out.add(r.toString());
  return out;
}

export async function subsetFonts(bytes: Uint8Array): Promise<{ bytes: Uint8Array; report: SubsetReport }> {
  const sd = await openSurgeonDoc(bytes);
  const ctx = sd.ctx;
  const report: SubsetReport = { fonts: [], saved: 0 };
  collectUse(sd);
  const keep = formFonts(ctx, sd.pdf.catalog);
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  for (const [ref, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || nameOf(o.get(PDFName.of("Subtype"))) !== "Type0" || keep.has(ref.toString())) continue;
    const enc = nameOf(o.get(PDFName.of("Encoding")));
    if (enc !== "Identity-H" && enc !== "Identity-V") continue;
    const base = nameOf(o.get(PDFName.of("BaseFont"))) ?? "";
    if (/^[A-Z]{6}\+/.test(base)) continue; // already a subset
    const desc = look(ctx, o.get(PDFName.of("DescendantFonts")));
    const cid = desc instanceof PDFArray ? dictOf(look(ctx, desc.get(0))) : undefined;
    if (!cid || nameOf(cid.get(PDFName.of("Subtype"))) !== "CIDFontType2") continue;
    const map = cid.get(PDFName.of("CIDToGIDMap"));
    if (map && nameOf(look(ctx, map)) !== "Identity") continue;
    const fd = dictOf(dget(ctx, cid, "FontDescriptor"));
    const ffRef = fd?.get(PDFName.of("FontFile2"));
    const ff = look(ctx, ffRef);
    if (!fd || !(ff instanceof PDFStream)) continue;
    const info = sd.fontCache.get(ref.toString()) ?? [...sd.fontCache.values()].find((f) => f.ref?.toString() === ref.toString());
    if (!info || !info.used.size) continue;
    let program: Uint8Array;
    try {
      program = streamBytes(ctx, ff);
    } catch {
      continue;
    }
    let font: any;
    try {
      font = fontkit.create(program as any);
    } catch (e) {
      console.warn("font subset: cannot read", base, e);
      continue;
    }
    if (!font.numGlyphs || font.cff || typeof font.createSubset !== "function") continue; // TrueType outlines only
    const subset = font.createSubset();
    padTtfSubsetGlyphs(subset);
    const used = [...info.used].filter((c) => c >= 0 && c < font.numGlyphs).sort((a, b) => a - b);
    const newGid = new Map<number, number>();
    for (const g of used) newGid.set(g, subset.includeGlyph(font.getGlyph(g)));
    const data: Uint8Array = await new Promise((resolve, reject) => {
      const parts: Uint8Array[] = [];
      subset
        .encodeStream()
        .on("data", (b: Uint8Array) => parts.push(b))
        .on("end", () => {
          const n = parts.reduce((s, p) => s + p.length, 0);
          const out = new Uint8Array(n);
          let k = 0;
          for (const p of parts) out.set(p, k), (k += p.length);
          resolve(out);
        })
        .on("error", reject);
    });
    if (data.length >= program.length * 0.9) continue;
    const max = used[used.length - 1] ?? 0;
    const cidMap = new Uint8Array((max + 1) * 2);
    for (const [c, g] of newGid) (cidMap[c * 2] = g >> 8), (cidMap[c * 2 + 1] = g & 255);
    const nf = ctx.flateStream(data, { Length1: data.length });
    const tag = TAG();
    const name = `${tag}+${base}`;
    if (ffRef instanceof PDFRef) ctx.assign(ffRef, nf);
    else fd.set(PDFName.of("FontFile2"), ctx.register(nf));
    cid.set(PDFName.of("CIDToGIDMap"), ctx.register(ctx.flateStream(cidMap)));
    o.set(PDFName.of("BaseFont"), PDFName.of(name));
    cid.set(PDFName.of("BaseFont"), PDFName.of(name));
    fd.set(PDFName.of("FontName"), PDFName.of(name));
    report.fonts.push({ name: base, before: program.length, after: data.length, glyphs: used.length });
    report.saved += program.length - data.length;
  }
  if (!report.fonts.length) return { bytes, report };
  return { bytes: await savePdf(sd.pdf), report };
}
