// A PPTX written anew (exportPptx) is a package PowerPoint opens: what PowerPoint refuses with E_FAIL without a
// window — child elements out of the schema's sequence (ECMA-376 PresentationML / DrawingML), relationships to parts
// that are not there, parts without a content type, r:id references a part's rels do not have. Checked without
// PowerPoint (QA 2026-11-15: p:txStyles written before p:sldLayoutIdLst in the master made every such save fail).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync, writeFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { newDocument, type Page } from "../../src/core/types";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { builtinLayout, slideFromLayout } from "../../src/core/slides";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/** The schema sequence of an element's children (names in one string are a choice, at the same place). */
const SEQ: Record<string, string[]> = {
  "p:presentation": ["sldMasterIdLst", "notesMasterIdLst", "handoutMasterIdLst", "sldIdLst", "sldSz", "notesSz", "smartTags", "embeddedFontLst", "custShowLst", "photoAlbum", "custDataLst", "kinsoku", "defaultTextStyle", "modifyVerifier", "extLst"],
  "p:sldMaster": ["cSld", "clrMap", "sldLayoutIdLst", "transition", "timing", "hf", "txStyles", "extLst"],
  "p:sldLayout": ["cSld", "clrMapOvr", "transition", "timing", "hf", "extLst"],
  "p:sld": ["cSld", "clrMapOvr", "transition", "timing", "extLst"],
  "p:notes": ["cSld", "clrMapOvr", "extLst"],
  "p:notesMaster": ["cSld", "clrMap", "hf", "notesStyle", "extLst"],
  "p:cSld": ["bg", "spTree", "custDataLst", "controls", "extLst"],
  "p:sp": ["nvSpPr", "spPr", "style", "txBody", "extLst"],
  "p:pic": ["nvPicPr", "blipFill", "spPr", "style", "extLst"],
  "p:cxnSp": ["nvCxnSpPr", "spPr", "style", "extLst"],
  "p:graphicFrame": ["nvGraphicFramePr", "xfrm", "graphic", "extLst"],
  "p:grpSp": ["nvGrpSpPr", "grpSpPr"],
  "p:nvSpPr": ["cNvPr", "cNvSpPr", "nvPr"],
  "p:nvPicPr": ["cNvPr", "cNvPicPr", "nvPr"],
  "p:nvPr": ["ph", "audioCd wavAudioFile audioFile videoFile quickTimeFile", "custDataLst", "extLst"],
  "p:txStyles": ["titleStyle", "bodyStyle", "otherStyle", "extLst"],
  "p:txBody": ["bodyPr", "lstStyle", "p"],
  "a:txBody": ["bodyPr", "lstStyle", "p"],
  "a:p": ["pPr", "r br fld", "endParaRPr"],
  "a:r": ["rPr", "t"],
  "a:pPr": ["lnSpc", "spcBef", "spcAft", "buClrTx buClr", "buSzTx buSzPct buSzPts", "buFontTx buFont", "buNone buAutoNum buChar buBlip", "tabLst", "defRPr", "extLst"],
  "a:rPr": ["ln", "noFill solidFill gradFill blipFill pattFill grpFill", "effectLst effectDag", "highlight", "uLnTx uLn", "uFillTx uFill", "latin", "ea", "cs", "sym", "hlinkClick", "hlinkMouseOver", "rtl", "extLst"],
  "a:tbl": ["tblPr", "tblGrid", "tr"],
  "a:tc": ["txBody", "tcPr", "extLst"],
  "a:tcPr": ["lnL", "lnR", "lnT", "lnB", "lnTlToBr", "lnBlToTr", "cell3D", "noFill solidFill gradFill blipFill pattFill grpFill", "headers", "extLst"],
  "p:spPr": ["xfrm", "custGeom prstGeom", "noFill solidFill gradFill blipFill pattFill grpFill", "ln", "effectLst effectDag", "scene3d", "sp3d", "extLst"],
  "p:grpSpPr": ["xfrm", "noFill solidFill gradFill blipFill pattFill grpFill", "effectLst effectDag", "scene3d", "extLst"],
  "a:xfrm": ["off", "ext", "chOff", "chExt"],
};
/** Children an element must have. */
const REQUIRED: Record<string, string[]> = {
  "p:sldMaster": ["cSld", "clrMap"],
  "p:sld": ["cSld"],
  "p:sldLayout": ["cSld"],
  "p:notesMaster": ["cSld", "clrMap"],
  "p:cSld": ["spTree"],
  "p:sp": ["nvSpPr", "spPr"],
  "p:txBody": ["bodyPr"],
  "a:txBody": ["bodyPr"],
  "a:tc": [],
};

const prefixOf = (ns: string | null) => (ns === NS_P ? "p" : ns === NS_A ? "a" : null);

function orderProblems(part: string, root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    const pre = prefixOf(el.namespaceURI);
    const key = pre && `${pre}:${el.localName}`;
    const kids: Element[] = [];
    for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) kids.push(c as Element);
    const seq = key ? SEQ[key] : undefined;
    if (seq) {
      let at = -1;
      for (const k of kids) {
        if (prefixOf(k.namespaceURI) === null) continue; // mc:AlternateContent, p14:… — another schema's business
        const rank = seq.findIndex((s) => s.split(" ").includes(k.localName));
        if (rank < 0) continue;
        if (rank < at) out.push(`${part}: <${key}> has <${k.localName}> after <${seq[at].split(" ")[0]}>`);
        at = Math.max(at, rank);
      }
    }
    for (const r of (key && REQUIRED[key]) || []) if (!kids.some((k) => k.localName === r)) out.push(`${part}: <${key}> without <${r}>`);
    kids.forEach(walk);
  };
  walk(root);
  return out;
}

/** Everything in the package PowerPoint would refuse that can be seen without it. */
export function pptxPackageProblems(bytes: Uint8Array): string[] {
  const files = unzipSync(bytes);
  const names = new Set(Object.keys(files));
  const out: string[] = [];
  const parse = (name: string) => new DOMParser().parseFromString(strFromU8(files[name]), "application/xml").documentElement as unknown as Element;
  // content types: every part has one
  const ct = parse("[Content_Types].xml");
  const defaults = new Set<string>(), overrides = new Set<string>();
  for (let c = ct.firstChild; c; c = c.nextSibling) {
    if (c.nodeType !== 1) continue;
    const e = c as Element;
    if (e.localName === "Default") defaults.add((e.getAttribute("Extension") ?? "").toLowerCase());
    else if (e.localName === "Override") overrides.add(e.getAttribute("PartName") ?? "");
  }
  for (const o of overrides) if (!names.has(o.slice(1))) out.push(`[Content_Types].xml: Override for missing ${o}`);
  for (const n of names) {
    if (n === "[Content_Types].xml" || n.endsWith("/")) continue;
    if (!overrides.has(`/${n}`) && !defaults.has(n.split(".").pop()!.toLowerCase())) out.push(`${n}: no content type`);
  }
  if (!names.has("_rels/.rels")) out.push("no _rels/.rels");
  // relationships: targets are there; r:… references are in the part's rels
  for (const n of names) {
    const m = /^(.*?)_rels\/([^/]+)\.rels$/.exec(n);
    if (!m) continue;
    const base = m[1], src = m[1] + m[2];
    if (src && !names.has(src)) out.push(`${n}: rels of a missing part`);
    const ids = new Set<string>();
    const rels = parse(n);
    for (let c = rels.firstChild; c; c = c.nextSibling) {
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      const id = e.getAttribute("Id") ?? "";
      if (ids.has(id)) out.push(`${n}: ${id} twice`);
      ids.add(id);
      if (e.getAttribute("TargetMode") === "External") continue;
      const t = e.getAttribute("Target") ?? "";
      const parts = (t.startsWith("/") ? t.slice(1) : base + t).split("/");
      const abs: string[] = [];
      for (const p of parts) p === ".." ? abs.pop() : p !== "." && abs.push(p);
      if (!names.has(abs.join("/"))) out.push(`${n}: ${id} → missing ${abs.join("/")}`);
    }
    if (src && /\.xml$/.test(src)) {
      const xml = strFromU8(files[src]);
      for (const [, id] of xml.matchAll(/\br:(?:id|embed|link|pict)="([^"]+)"/g)) if (!ids.has(id)) out.push(`${src}: r:… "${id}" not in its rels`);
    }
  }
  for (const n of names) {
    if (!/^ppt\/.*\.xml$/.test(n)) continue;
    const xml = strFromU8(files[n]);
    if (/\br:(?:id|embed|link)="/.test(xml) && !names.has(n.replace(/([^/]+)$/, "_rels/$1.rels"))) out.push(`${n}: r:… references without a rels part`);
    out.push(...orderProblems(n, parse(n)));
  }
  // the presentation's own lists point at the parts they name
  const pres = strFromU8(files["ppt/presentation.xml"]);
  if (!/<p:sldMasterIdLst>/.test(pres)) out.push("ppt/presentation.xml: no p:sldMasterIdLst");
  void NS_R;
  return out;
}

describe("PPTX written anew: a package PowerPoint opens", () => {
  it("(the check itself: PowerPoint's own files pass it)", () => {
    for (const f of ["omni-pptx-fidelity.pptx", "omni-pptx-media.pptx", "omni-pptx-surgeon.pptx"]) expect(pptxPackageProblems(new Uint8Array(readFileSync(`qa/interop/adobe-made/${f}`))), f).toEqual([]);
  });

  it("the imported PowerPoint test deck, written anew", async () => {
    const { pages, assets } = importPptx(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-fidelity.pptx")), "omni-pptx-fidelity.pptx");
    const doc = newDocument("t");
    doc.pages = pages;
    doc.assets = assets;
    const { bytes } = await exportPptx(doc, pages);
    expect(pptxPackageProblems(bytes)).toEqual([]);
  });

  it("the media deck written anew (video, audio, posters, timing)", async () => {
    const { pages, assets } = importPptx(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-media.pptx")), "omni-pptx-media.pptx");
    const doc = newDocument("t");
    doc.pages = pages;
    doc.assets = assets;
    const { bytes } = await exportPptx(doc, pages);
    expect(pptxPackageProblems(bytes)).toEqual([]);
  });

  it("new slides from layouts, with notes, a hidden slide and sections", async () => {
    const doc = newDocument("d");
    const pages: Page[] = [slideFromLayout(builtinLayout("title", 1280, 720), 1280, 720, "s1"), slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "s2"), slideFromLayout(builtinLayout("twoContent", 1280, 720), 1280, 720, "s3")];
    (pages[0] as any).notes = "발표자 노트 1"; // i18n: keep — test data
    (pages[1] as any).hidden = true;
    (pages[0] as any).section = "도입"; // i18n: keep
    (pages[2] as any).section = "본론"; // i18n: keep
    doc.pages = pages;
    const { bytes } = await exportPptx(doc, pages);
    expect(pptxPackageProblems(bytes)).toEqual([]);
    // (for the PowerPoint check: qa/interop/scripts/pptx_surgeon_check.ps1 <file>)
    if (process.env.OMNIWEAVE_PPTX_SLIDES_OUT) writeFileSync(process.env.OMNIWEAVE_PPTX_SLIDES_OUT, bytes);
  });
});
