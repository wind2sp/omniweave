// More of a worksheet for the sheet model (표 계산 읽기 보충): notes (legacy comments, xl/commentsN.xml found through the
// sheet's relationships), threaded comments (Excel 365, shown as read-only notes), data validation rules (also the
// x14 extension Excel writes for lists on other sheets) and the AutoFilter range with its value filters.

import type { SheetData, SheetFilter, SheetNote, SheetValidation } from "../../core/sheetTypes";
import { attr, child, children, descendants, parseXml, textOf } from "../xml";

/** Package path of a relationship target, relative to the part that owns the relationships. */
export function relTarget(part: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const out = part.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}
/** The relationships part of a part. */
export const relsOf = (part: string) => part.replace(/([^/]+)$/, "_rels/$1.rels");

/** Relationships of a part: id → { type (last segment), target path }. */
export function partRels(part: string, read: (p: string) => string | undefined): Map<string, { type: string; target: string; external: boolean }> {
  const out = new Map<string, { type: string; target: string; external: boolean }>();
  const x = read(relsOf(part));
  if (!x) return out;
  for (const r of descendants(parseXml(x), "Relationship")) {
    const external = attr(r, "TargetMode") === "External";
    out.set(attr(r, "Id") ?? "", { type: (attr(r, "Type") ?? "").replace(/^.*\//, ""), target: external ? attr(r, "Target") ?? "" : relTarget(part, attr(r, "Target") ?? ""), external });
  }
  return out;
}

const bool = (v: string | null) => /^(1|true)$/.test(v ?? "");

/** Text of a comment (<text> with runs; phonetic runs left out). */
function richText(el: Element): string {
  const ts = descendants(el, "t").filter((t) => (t.parentNode as Element | null)?.localName !== "rPh");
  return ts.map(textOf).join("");
}

export function readExtra(sh: SheetData, root: Element, part: string, read: (p: string) => string | undefined): void {
  const rels = partRels(part, read);
  // notes
  const notes: Record<string, SheetNote> = {};
  for (const rel of rels.values()) {
    if (rel.type !== "comments" || rel.external) continue;
    const x = read(rel.target);
    if (!x) continue;
    const doc = parseXml(x);
    const authors = descendants(doc, "author").map(textOf);
    for (const c of descendants(doc, "comment")) {
      const ref = attr(c, "ref");
      const tx = child(c, "text");
      if (!ref || !tx) continue;
      const a = authors[Number(attr(c, "authorId") ?? 0)];
      notes[ref.toUpperCase()] = { text: richText(tx), ...(a ? { author: a } : {}) };
    }
  }
  for (const rel of rels.values()) {
    if (rel.type !== "threadedComment" || rel.external) continue;
    const x = read(rel.target);
    if (!x) continue;
    const byRef = new Map<string, string[]>();
    for (const c of descendants(parseXml(x), "threadedComment")) {
      const ref = (attr(c, "ref") ?? "").toUpperCase();
      const tx = child(c, "text");
      if (!ref) continue;
      byRef.set(ref, [...(byRef.get(ref) ?? []), tx ? textOf(tx) : ""]);
    }
    for (const [ref, texts] of byRef) notes[ref] = { text: texts.join("\n"), threaded: true };
  }
  if (Object.keys(notes).length) sh.notes = notes;

  // data validation
  const valid: SheetValidation[] = [];
  const one = (dv: Element, sqref: string, f1?: string, f2?: string) => {
    const v: SheetValidation = { ranges: sqref.split(/\s+/).filter(Boolean), type: attr(dv, "type") ?? "none" };
    const op = attr(dv, "operator");
    if (op) v.op = op;
    if (f1 != null) v.f1 = f1;
    if (f2 != null) v.f2 = f2;
    if (bool(attr(dv, "allowBlank"))) v.allowBlank = true;
    if (bool(attr(dv, "showDropDown"))) v.noDropdown = true;
    if (bool(attr(dv, "showErrorMessage"))) v.showError = true;
    const es = attr(dv, "errorStyle");
    if (es) v.errStyle = es;
    const et = attr(dv, "errorTitle");
    if (et) v.errTitle = et;
    const em = attr(dv, "error");
    if (em) v.error = em;
    if (v.ranges.length) valid.push(v);
  };
  for (const dvs of children(root, "dataValidations"))
    for (const dv of children(dvs, "dataValidation")) {
      const f1 = child(dv, "formula1"), f2 = child(dv, "formula2");
      one(dv, attr(dv, "sqref") ?? "", f1 ? textOf(f1) : undefined, f2 ? textOf(f2) : undefined);
    }
  // x14:dataValidations in extLst (lists on other sheets)
  for (const dv of descendants(root, "dataValidation")) {
    if (dv.namespaceURI === root.namespaceURI) continue;
    const sq = descendants(dv, "sqref")[0];
    const fx = (n: string) => {
      const e = descendants(dv, n)[0];
      const f = e && descendants(e, "f")[0];
      return f ? textOf(f) : undefined;
    };
    if (sq) one(dv, textOf(sq), fx("formula1"), fx("formula2"));
  }
  if (valid.length) sh.valid = valid;

  // AutoFilter
  const af = child(root, "autoFilter");
  const ref = af && attr(af, "ref");
  if (af && ref) {
    const f: SheetFilter = { ref: ref.replace(/\$/g, "").toUpperCase() };
    for (const fc of children(af, "filterColumn")) {
      const id = Number(attr(fc, "colId") ?? 0);
      const fs = child(fc, "filters");
      f.cols ??= {};
      const other = children(fc).some((k) => k.localName !== "filters") || !fs || children(fs).some((k) => k.localName !== "filter");
      if (other || !fs) f.cols[id] = { other: true };
      else f.cols[id] = { vals: children(fs, "filter").map((x) => attr(x, "val") ?? ""), ...(bool(attr(fs, "blank")) ? { blank: true } : {}) };
    }
    sh.filter = f;
  }
}
