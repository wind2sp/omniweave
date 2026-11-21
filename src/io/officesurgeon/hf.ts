// Office Surgeon — headers, footers and page numbering (core/headerFooter.ts) of a DOCX / HWPX save.
//
// The original's sections are read again with the importer (OfficeLayout sections with their `hf`) and compared with
// the pages' sections, part by part, by content (fields by kind, not by the value they last showed):
//   DOCX  • an unchanged part keeps its bytes; a changed part (header{n}.xml / footer{n}.xml) is rewritten alone —
//           a picture or shape in it is dropped and said so;
//         • a new variant adds a part, its relationship, its content type and a reference in that section's w:sectPr;
//           a variant linked again drops the reference; titlePg / pgNumType / settings evenAndOddHeaders are patched;
//   HWPX  • unchanged → nothing; any change falls back to writing the file anew (with the notice): 한글 keeps its header
//           controls inside body paragraphs, which this stage does not rewrite.
// Maps from before headers were read (OfficeSourceMeta.hf absent: an .omw saved by an older app, whose pages have no
// headers) skip the comparison — the original's headers stay exactly as they were.

import { hashString } from "../../core/hash";
import type { OfficeSourceMeta, Page, SectionHF, TextParagraph } from "../../core/types";
import { t } from "../../i18n";
import { DOCX_HF_TYPES, docxHFPartXml, docxHFSections, docxSectHFXml, type DocxHFPart, type DocxHFSection, type OfficeLayout } from "../office";
import { paraPropsKey, runKey } from "./common";
import { SurgeryUnavailable } from "./docx";
import { entryData, type ZipArchive } from "./zip";
import { strFromU8 } from "fflate";
import { sectionsOf } from "../../core/pageSetup";

/** Version of the header / footer part of the maps (set on maps made by an importer that reads headers). */
export const HF_MAP_VERSION = 1;

/** Content key of header / footer paragraphs: format and text, fields by kind (their shown value changes per page). */
export function hfParasKey(ps: readonly TextParagraph[]): string {
  return hashString(
    JSON.stringify(
      ps.map((p) => {
        const runs: [string, string][] = [];
        for (const r of p.runs) {
          if (!r.text && !r.field) continue;
          const key = runKey(r);
          const text = r.field ? `\u0000${r.field}\u0000${r.fieldCode ?? ""}` : r.text;
          const last = runs[runs.length - 1];
          if (last && last[0] === key && !r.field && !last[1].startsWith("\u0000")) last[1] += text;
          else runs.push([key, text]);
        }
        return [paraPropsKey(p), runs];
      }),
    ),
  );
}

const partKey = (p: DocxHFPart) => hfParasKey(p.paras) + "|" + JSON.stringify(p.pn);

/** The sections' hf of the pages, in sectionsOf order (as flowLayout gives them). */
export interface HFCompare {
  cur: (SectionHF | undefined)[];
  orig: OfficeLayout["sections"];
  curEvenOdd: boolean;
}

/** Whether the headers / footers / numbering differ from the original's (false for maps without headers). */
export function hfChanged(meta: OfficeSourceMeta, c: HFCompare): boolean {
  if ((meta.hf ?? 0) < HF_MAP_VERSION) return false;
  if (c.curEvenOdd !== !!c.orig[0]?.hf?.evenOdd) return true;
  const a = docxHFSections(c.orig.map((s) => s.hf), c.curEvenOdd), b = docxHFSections(c.cur, c.curEvenOdd);
  if (a.length !== b.length) return true;
  return a.some((s, j) => secKey(s) !== secKey(b[j]));
}
const secKey = (s: DocxHFSection) => JSON.stringify([s.parts.map((p) => [p.area, p.variant, partKey(p)]), s.titlePg, s.fmt ?? null, s.start ?? null]);

const SECTPR = /<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g;
const REF = /<w:(headerReference|footerReference)\b[^>]*\/>/g;

/**
 * DOCX: write the header / footer changes into `changed` (parts, relationships, content types, settings) and return the
 * body with the sections' w:sectPr patched. `warnings` receives what is lost.
 */
export function applyDocxHF(zip: ZipArchive, c: HFCompare, bodyXml: string, changed: Map<string, Uint8Array>, warnings: string[], rNs = true): string {
  const enc = new TextEncoder();
  const read = (name: string) => {
    const got = changed.get(name);
    if (got) return strFromU8(got);
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  const relsPath = "word/_rels/document.xml.rels";
  let rels = read(relsPath);
  let ct = read("[Content_Types].xml");
  if (rels == null || ct == null) throw new SurgeryUnavailable("rels");
  const relTarget = (id: string) => {
    const m = new RegExp(`<Relationship\\b[^>]*\\bId="${id}"[^>]*>`).exec(rels!);
    const tg = m && /\bTarget="([^"]+)"/.exec(m[0])?.[1];
    return tg ? (tg.startsWith("/") ? tg.slice(1) : "word/" + tg) : null;
  };
  const a = docxHFSections(c.orig.map((s) => s.hf), c.curEvenOdd), b = docxHFSections(c.cur, c.curEvenOdd);
  const found = [...bodyXml.matchAll(SECTPR)];
  let lostPictures = false;
  const edits = new Map<number, string>();
  const names = new Set(zip.entries.map((e) => e.name));
  for (const n of changed.keys()) names.add(n);
  const freeName = (area: string) => {
    let n = 1;
    while (names.has(`word/${area}${n}.xml`)) n++;
    names.add(`word/${area}${n}.xml`);
    return `${area}${n}.xml`;
  };
  // parts more than one reference points at (another section's, or another variant's): an edit gets a part of its own
  const uses = new Map<string, number>();
  for (const m of found)
    for (const r of m[0].matchAll(REF)) {
      const path = relTarget(/\br:id="([^"]+)"/.exec(r[0])?.[1] ?? "");
      if (path) uses.set(path, (uses.get(path) ?? 0) + 1);
    }
  let relN = 0;
  const freeId = () => {
    let id: string;
    do id = `rIdOmwHF${++relN}`;
    while (rels!.includes(`Id="${id}"`));
    return id;
  };
  b.forEach((cur, j) => {
    const orig = a[j];
    if (secKey(cur) === secKey(orig)) return;
    const src = c.orig[j]?.src;
    if (src === undefined || src >= found.length) throw new SurgeryUnavailable("section settings");
    let sect = found[src][0];
    if (sect.includes("sectPrChange")) throw new SurgeryUnavailable("tracked section change");
    if (sect.endsWith("/>")) sect = sect.slice(0, -2) + "></w:sectPr>";
    const refs = new Map<string, { xml: string; id: string }>();
    for (const m of sect.matchAll(REF)) {
      const area = m[1] === "headerReference" ? "header" : "footer";
      const type = /\bw:type="([^"]+)"/.exec(m[0])?.[1] ?? "default";
      const id = /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
      refs.set(`${area}|${type}`, { xml: m[0], id });
    }
    for (const area of ["header", "footer"] as const)
      for (const v of ["default", "first", "even"] as const) {
        const o = orig.parts.find((p) => p.area === area && p.variant === v);
        const n = cur.parts.find((p) => p.area === area && p.variant === v);
        if (!o && !n) continue;
        if (o && n && partKey(o) === partKey(n)) continue;
        const ref = refs.get(`${area}|${v}`);
        if (n) {
          const path = ref && relTarget(ref.id);
          const shared = !!path && (uses.get(path) ?? 0) > 1;
          if (path && !shared) {
            const old = read(path) ?? "";
            if (/<w:(drawing|pict|object)\b|<mc:AlternateContent\b/.test(old)) lostPictures = true;
            changed.set(path, enc.encode(docxHFPartXml(n)));
          } else {
            const name = freeName(area);
            const id = freeId();
            changed.set(`word/${name}`, enc.encode(docxHFPartXml(n)));
            rels = rels!.replace("</Relationships>", `<Relationship Id="${id}" Type="${DOCX_HF_TYPES[area].rel}" Target="${name}"/></Relationships>`);
            ct = ct!.replace("</Types>", `<Override PartName="/word/${name}" ContentType="${DOCX_HF_TYPES[area].ct}"/></Types>`);
            const xml = `<w:${area}Reference w:type="${v}" r:id="${id}"/>`;
            if (!rNs && !sect.includes("xmlns:r=")) throw new SurgeryUnavailable("namespace");
            if (ref && shared) {
              // the shared part stays as it is for the others; this section now points at a part of its own
              uses.set(path!, uses.get(path!)! - 1);
              sect = sect.replace(ref.xml, xml);
            } else sect = sect.replace(/^<w:sectPr\b[^>]*>/, (open) => open + xml);
          }
        } else if (ref) sect = sect.replace(ref.xml, "");
      }
    // numbering and different first page (CT_SectPr order: … pgMar … pgNumType cols … titlePg textDirection … docGrid)
    const hx = docxSectHFXml(cur, []);
    sect = sect.replace(/<w:pgNumType\b[^>]*\/>/, "").replace(/<w:titlePg\b[^>]*\/>/, "");
    if (hx.pgNumType) sect = insertBefore(sect, ["cols", "formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings"], hx.pgNumType);
    if (hx.titlePg) sect = insertBefore(sect, ["textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings"], hx.titlePg);
    edits.set(src, sect);
  });
  // different odd and even pages: word/settings.xml
  if (c.curEvenOdd !== !!c.orig[0]?.hf?.evenOdd) {
    const settings = read("word/settings.xml");
    if (settings == null) throw new SurgeryUnavailable("settings");
    let s = settings.replace(/<w:evenAndOddHeaders\b[^>]*\/>/, "");
    if (c.curEvenOdd) s = insertBefore(s, SETTINGS_AFTER_EVEN_ODD, "<w:evenAndOddHeaders/>", "</w:settings>");
    changed.set("word/settings.xml", enc.encode(s));
  }
  if (rels !== read(relsPath)) changed.set(relsPath, enc.encode(rels));
  if (ct !== read("[Content_Types].xml")) changed.set("[Content_Types].xml", enc.encode(ct));
  if (lostPictures) warnings.push(t("engine.officeSurgeon.hfPicture"));
  let out = "", last = 0;
  found.forEach((m, i) => {
    const s = edits.get(i);
    if (s === undefined) return;
    out += bodyXml.slice(last, m.index) + s;
    last = m.index! + m[0].length;
  });
  return out + bodyXml.slice(last);
}

/** w:settings children that come after evenAndOddHeaders (CT_Settings order) */
const SETTINGS_AFTER_EVEN_ODD = [
  "bookFoldRevPrinting", "bookFoldPrinting", "bookFoldPrintingSheets", "drawingGridHorizontalSpacing", "drawingGridVerticalSpacing", "displayHorizontalDrawingGridEvery",
  "displayVerticalDrawingGridEvery", "doNotUseMarginsForDrawingGridOrigin", "drawingGridHorizontalOrigin", "drawingGridVerticalOrigin", "doNotShadeFormData", "noPunctuationKerning",
  "characterSpacingControl", "printTwoOnOne", "strictFirstAndLastChars", "noLineBreaksAfter", "noLineBreaksBefore", "savePreviewPicture", "doNotValidateAgainstSchema", "saveInvalidXml",
  "ignoreMixedContent", "alwaysShowPlaceholderText", "doNotDemarcateInvalidXml", "saveXmlDataOnly", "useXSLTWhenSaving", "saveThroughXslt", "showXMLTags", "alwaysMergeEmptyNamespace",
  "updateFields", "hdrShapeDefaults", "footnotePr", "endnotePr", "compat", "docVars", "rsids", "mathPr", "attachedSchema", "themeFontLang", "clrSchemeMapping", "doNotIncludeSubdocsInStats",
  "doNotAutoCompressPictures", "forceUpgrade", "captions", "readModeInkLockDown", "smartTagType", "schemaLibrary", "shapeDefaults", "doNotEmbedSmartTags", "decimalSymbol", "listSeparator",
];

/** `xml` with `add` before the first of the named w: elements (else before `end`, by default the closing tag). */
function insertBefore(xml: string, names: string[], add: string, end = "</w:sectPr>"): string {
  let at = -1;
  for (const n of names) {
    const m = new RegExp(`<w:${n}\\b`).exec(xml);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = xml.lastIndexOf(end);
  if (at < 0) throw new SurgeryUnavailable("section settings");
  return xml.slice(0, at) + add + xml.slice(at);
}

/** Key of the pages' headers / footers / numbering as a whole (HWPX maps keep the one made at import). */
export function hfStateKey(pages: Page[]): string {
  const evenOdd = !!pages[0]?.hf?.evenOdd;
  const hfs = sectionsOf(pages).map((r) => pages[r.start].hf);
  return hashString(JSON.stringify([evenOdd, docxHFSections(hfs, evenOdd).map(secKey)]));
}

/**
 * A map made before headers were read (an older .omw: its pages had none) whose pages have headers / footers / page
 * numbers now — made in this app. They cannot be compared with the original's (which the pages never showed), so the
 * save is written anew from the pages, as they look (else the original's bytes would come back without them).
 */
export function hfAddedToOldMap(meta: OfficeSourceMeta, pages: readonly Page[]): boolean {
  return (meta.hf ?? 0) < HF_MAP_VERSION && pages.some((p) => p.hf);
}

/** HWPX: headers / footers changed since import (a map without the key — made before headers were read — never). */
export function hwpxHFChanged(meta: OfficeSourceMeta, pages: Page[]): boolean {
  return (meta.hf ?? 0) >= HF_MAP_VERSION && !!meta.hfKey && meta.hfKey !== hfStateKey(pages);
}
