// What the HWP 5.0 save needs to know at open time and in the export menu, without the writer itself: which pages came
// from an HWP file and their fingerprint as opened (the rules are in hwp5Write.ts above hwp5Source). The writer
// (hwp5Write.ts, hwp5Body.ts, hwp5Preview.ts) is loaded only when a document is saved as HWP (io/formats/index.ts),
// so it stays out of the start-up chunk (docs/design/INSTALLER_SIZE.md §12).

import { hashString } from "../../core/hash";
import type { Page, PageSource, TextParagraph } from "../../core/types";
import { collectFlow, flowNotes } from "../office";
import { itemFp, noteFp } from "../officesurgeon/common";
import { hfStateKey } from "../officesurgeon/hf";

/** Node types the HWP import makes (through HWPX) and the HWPX surgeon compares; any other is an edit. */
export const HWP5_NODE_TYPES = new Set<string>(["TEXT", "TABLE", "IMAGE"]);

/** The source of the pages that came from one HWP file (its first page holds the original and the HWPX map). */
export function hwp5Source(pages: readonly Page[]): PageSource | undefined {
  return pages.find((p) => p.source?.hwp5 && p.source.office)?.source;
}

/** Review marks in the body: tracked changes and comment ranges on runs / paragraphs, and the document's comments. */
export function reviewMarks(pages: readonly Page[], flow: ReturnType<typeof collectFlow>): number {
  let n = pages[0]?.comments?.length ?? 0;
  const para = (p: TextParagraph) => {
    if (p.markRev || p.fmtRev) n++;
    for (const r of p.runs) if (r.rev || r.fmtRev || r.comments?.length) n++;
  };
  for (const it of flow) {
    if (it.kind === "p") para(it.p);
    else for (const row of it.t.rows) for (const c of row) c.richText?.forEach(para);
  }
  for (const note of flowNotes(flow)) note.paras.forEach(para);
  return n;
}

const omit = (o: object, keys: readonly string[]) => Object.fromEntries(Object.entries(o).filter(([k, v]) => !keys.includes(k) && v !== undefined));

/**
 * A paragraph's format beyond paraPropsKey (itemFp has those, and the surgeon writes them): everything but its text, its
 * place in the body flow, the line layout 한글 cached, the review marks (reviewMarks counts them) and those formats — so
 * deleting the one centred title is still a text edit.
 */
const PARA_KEYED = ["id", "runs", "flowSplit", "flowCont", "hwpLines", "markRev", "fmtRev", "align", "lineSpacing", "indent", "indentLeft", "spaceAfter", "role", "spaceBefore", "indentRight", "lineHeight", "keepNext", "keepLines", "pageBreakBefore", "list", "wordLine", "lineMultiple"];
export const paraExtraKey = (p: TextParagraph) => JSON.stringify(omit(p, PARA_KEYED));

/** Fingerprint of the pages for the HWP save (see above): `shape` without the body text, `fp` with it. */
export function hwp5Fingerprint(pages: readonly Page[]): { fp: string; shape: string } {
  const ps = pages as Page[];
  const flow = collectFlow(ps);
  const sections = ps.map((p, i) => (i === 0 || p.breakBefore !== "flow" ? [p.kind, p.width, p.height, p.margins ?? null, p.breakBefore ?? null, p.hf ?? null] : null)).filter(Boolean);
  const backgrounds = [...new Set(ps.map((p) => p.background.toLowerCase()))].sort();
  // objects other than the body flow's text and tables, without where the flow put them (it moves them as text reflows)
  // (QA 2026-11-15, stage 3) a floating picture is not moved by the flow (only body text, tables and pictures in the
  // line are flow nodes, core/flow.ts): where it is on its page is the user's — moving it is an edit
  const objects = ps
    // (a text box — a TEXT node outside the body flow, io/officeShapes.ts — is such an object too: one drawn here is an edit)
    .flatMap((p) => p.nodes.filter((n) => !n.notes && (n.type !== "TEXT" || !n.flow) && n.type !== "TABLE"))
    .map((n) => {
      const { x, y, ...tr } = n.transform as unknown as Record<string, unknown>;
      const place = (n as { place?: { mode?: string } }).place;
      const at = place?.mode === "float" && !n.flow ? [[Math.round(Number(x) * 100) / 100, Math.round(Number(y) * 100) / 100]] : [];
      return JSON.stringify([omit(n, ["id", "transform", "place"]), tr, place ? omit(place, ["offset", "para"]) : null, ...at]);
    })
    .sort();
  const frames = [...new Set(ps.flatMap((p) => p.nodes.filter((n) => n.type === "TEXT" && !n.notes)).map((n) => JSON.stringify(omit(n, ["id", "name", "transform", "paragraphs", "width"]))))].sort();
  // (QA 2026-11-15) the table settings itemFp leaves out — row height, background, cell margins, a cell's vertical
  // alignment / height …: the surgeon writes none of them, so a change of one alone was "none" (the original bytes, the
  // edit gone without a word) and one made together with a text edit was lost in the "text" save. In `shape`: refused.
  const tables = flow.flatMap((it) => (it.kind === "table" ? [JSON.stringify([omit(it.t, ["id", "name", "transform", "rows", "flowCont"]), it.t.rows.map((r) => r.map((c) => omit(c, ["text", "richText"])))])] : []));
  const shape = hashString(JSON.stringify({ sections, backgrounds, notePr: ps[0]?.notePr ?? null, objects, frames, review: reviewMarks(ps, flow), hf: hfStateKey(ps), tables }));
  // (QA 2026-11-15) and each paragraph's formats paraPropsKey leaves out (shading, borders, widow control …; no editor
  // command changes them yet): in `fp`, so a change of one is not "none" (hwp5Edit: the surgeon writes nothing → refused).
  // Not in `shape`: they are per-paragraph settings of the import (구역 tab step …) that deleting a paragraph removes.
  const extra = (it: (typeof flow)[number]) => (it.kind === "p" ? paraExtraKey(it.p) : it.t.rows.map((r) => r.map((c) => (c.richText ?? []).map(paraExtraKey).join("|")).join(",")).join(";"));
  const fp = hashString(shape + "\u0000" + flow.map((it) => itemFp(it) + extra(it)).join(",") + "\u0000" + flowNotes(flow).map(noteFp).join(","));
  return { fp, shape };
}
