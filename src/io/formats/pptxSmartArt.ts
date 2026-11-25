// SmartArt in PPTX (DrawingML diagrams, ECMA-376 Part 1 §21.4): a graphic made here (core/smartArt.ts) is written as
// PowerPoint's own SmartArt — only the diagram data (its items and levels) naming the built-in layout, quick style
// and colours it maps to. With no layout, style or colours part PowerPoint takes its own definitions by those ids
// (checked with PowerPoint 2026-11-24: all seven layouts come up as themselves, in the theme's colours) and draws
// and edits it as SmartArt (text pane, layouts, styles). Neither are its own definitions copied here.
// Reading: the data model gives the items back, and the layout id tells which of Omniweave's layouts it is.

import type { SmartData, SmartItem, SmartLayout } from "../../core/smartArt";
import { esc } from "../xml";

/** PowerPoint's built-in layout each Omniweave layout is written as (and read back from). */
export const LAYOUT_URN: Record<SmartLayout, { urn: string; cat: string }> = {
  blockList: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/default", cat: "list" },
  bulletList: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/vList2", cat: "list" },
  process: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/process1", cat: "process" },
  arrowProcess: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/chevron1", cat: "process" },
  cycle: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/cycle2", cat: "cycle" },
  hierarchy: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/orgChart1", cat: "hierarchy" },
  pyramid: { urn: "urn:microsoft.com/office/officeart/2005/8/layout/pyramid1", cat: "pyramid" },
};

/** The Omniweave layout of a PowerPoint layout id (null when it has none). */
export function layoutOfUrn(urn: string | null | undefined): SmartLayout | null {
  if (!urn) return null;
  for (const [k, v] of Object.entries(LAYOUT_URN)) if (v.urn === urn) return k as SmartLayout;
  return null;
}

export const CT_DGM = "application/vnd.openxmlformats-officedocument.drawingml.diagram";
export const NS_DGM = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
const NS = `xmlns:dgm="${NS_DGM}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const QS = "urn:microsoft.com/office/officeart/2005/8/quickstyle/simple1";
const CS = "urn:microsoft.com/office/officeart/2005/8/colors/accent1_2";

const guid = () => {
  const h = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}}`;
};

const emptyT = `<dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="ko-KR" altLang="en-US"/></a:p></dgm:t>`;

/** The diagram data part: the document point, a point per item, connections from each to its parent. */
export function dataModelXml(d: SmartData): string {
  const lo = LAYOUT_URN[d.layout];
  const doc = guid();
  const pts = [`<dgm:pt modelId="${doc}" type="doc"><dgm:prSet loTypeId="${lo.urn}" loCatId="${lo.cat}" qsTypeId="${QS}" qsCatId="simple" csTypeId="${CS}" csCatId="accent1" phldr="1"/><dgm:spPr/>${emptyT}</dgm:pt>`];
  const cxns: string[] = [];
  // the parent of each item: the nearest item before it one level up (the document for the top level)
  const stack: string[] = [doc];
  const order = new Map<string, number>();
  for (const it of fixLevels(d.items)) {
    const id = guid(), par = guid(), sib = guid(), cx = guid();
    stack.length = it.level + 1;
    const parent = stack[it.level] ?? doc;
    stack[it.level + 1] = id;
    const ord = order.get(parent) ?? 0;
    order.set(parent, ord + 1);
    pts.push(`<dgm:pt modelId="${id}"><dgm:prSet phldrT="[Text]"/><dgm:spPr/><dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="ko-KR" altLang="en-US" dirty="0"/><a:t>${esc(it.text)}</a:t></a:r></a:p></dgm:t></dgm:pt>`);
    pts.push(`<dgm:pt modelId="${par}" type="parTrans" cxnId="${cx}"><dgm:prSet/><dgm:spPr/>${emptyT}</dgm:pt>`);
    pts.push(`<dgm:pt modelId="${sib}" type="sibTrans" cxnId="${cx}"><dgm:prSet/><dgm:spPr/>${emptyT}</dgm:pt>`);
    cxns.push(`<dgm:cxn modelId="${cx}" srcId="${parent}" destId="${id}" srcOrd="${ord}" destOrd="0" parTransId="${par}" sibTransId="${sib}"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><dgm:dataModel ${NS}><dgm:ptLst>${pts.join("")}</dgm:ptLst><dgm:cxnLst>${cxns.join("")}</dgm:cxnLst><dgm:bg/><dgm:whole/></dgm:dataModel>`;
}

/** Levels that never skip one (a line two levels under its parent hangs one level under it). */
function fixLevels(items: SmartItem[]): SmartItem[] {
  let prev = -1;
  return items.map((it) => {
    const level = Math.max(0, Math.min(it.level, prev + 1));
    prev = level;
    return { ...it, level };
  });
}

/** p:graphicFrame of a SmartArt graphic (relationship ids of its data, layout, style and colours parts). */
export const smartFrameXml = (id: number, name: string, rids: [string, string, string, string], x: number, y: number, cx: number, cy: number) =>
  `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="${NS_DGM}"><dgm:relIds xmlns:dgm="${NS_DGM}" r:dm="${rids[0]}" r:lo="${rids[1]}" r:qs="${rids[2]}" r:cs="${rids[3]}"/></a:graphicData></a:graphic></p:graphicFrame>`;

/** The items of a diagram data part (top-down, with their levels) and its layout id; null when it has none. */
export function readDataModel(doc: Document): { items: SmartItem[]; layoutUrn: string | null } | null {
  const all = Array.from(doc.getElementsByTagNameNS("*", "pt"));
  const docPt = all.find((p) => p.getAttribute("type") === "doc");
  if (!docPt) return null;
  const prSet = Array.from(docPt.getElementsByTagNameNS("*", "prSet"))[0];
  const byId = new Map(all.map((p) => [p.getAttribute("modelId") ?? "", p]));
  const kids = new Map<string, { id: string; ord: number }[]>();
  for (const c of Array.from(doc.getElementsByTagNameNS("*", "cxn"))) {
    const t = c.getAttribute("type");
    if (t && t !== "parOf") continue;
    const src = c.getAttribute("srcId") ?? "", dst = c.getAttribute("destId") ?? "";
    const p = byId.get(dst);
    if (!p || (p.getAttribute("type") && p.getAttribute("type") !== "node" && p.getAttribute("type") !== "asst")) continue;
    kids.set(src, [...(kids.get(src) ?? []), { id: dst, ord: Number(c.getAttribute("srcOrd") ?? 0) }]);
  }
  const items: SmartItem[] = [];
  const walk = (id: string, level: number) => {
    for (const k of (kids.get(id) ?? []).sort((a, b) => a.ord - b.ord)) {
      const p = byId.get(k.id)!;
      const text = Array.from(p.getElementsByTagNameNS("*", "p"))
        .map((para) => Array.from(para.getElementsByTagNameNS("*", "t")).map((t) => t.textContent ?? "").join(""))
        .join(" ")
        .trim();
      items.push({ text, level });
      walk(k.id, level + 1);
    }
  };
  walk(docPt.getAttribute("modelId") ?? "", 0);
  return { items: items.filter((i) => i.text || items.length < 2), layoutUrn: prSet?.getAttribute("loTypeId") ?? null };
}
