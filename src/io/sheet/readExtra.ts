// More of a worksheet for the sheet model (표 계산 읽기 보충): notes (legacy comments, xl/commentsN.xml found through the
// sheet's relationships), threaded comments (Excel 365, shown as read-only notes), data validation rules (also the
// x14 extension Excel writes for lists on other sheets) and the AutoFilter range with its value filters.

import type { SheetCustomFilter, SheetData, SheetFilter, SheetLink, SheetNote, SheetSparkGroup, SheetValidation } from "../../core/sheetTypes";
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

/** <sheetProtection> attributes that protect when absent or "1" (objects / scenarios: off unless "1"). */
export const PROTECT_KEYS = ["formatCells", "formatColumns", "formatRows", "insertColumns", "insertRows", "insertHyperlinks", "deleteColumns", "deleteRows", "sort", "autoFilter", "pivotTables"];

/** Text of a comment (<text> with runs; phonetic runs left out). */
function richText(el: Element): string {
  const ts = descendants(el, "t").filter((t) => (t.parentNode as Element | null)?.localName !== "rPh");
  return ts.map(textOf).join("");
}

import { readPersons, readThreads } from "./threads";

export function readExtra(sh: SheetData, root: Element, part: string, read: (p: string) => string | undefined): void {
  const rels = partRels(part, read);
  // 시나리오 관리자
  const scs = child(root, "scenarios");
  if (scs) {
    const list = children(scs, "scenario").map((x) => {
      const ins = children(x, "inputCells");
      return { name: attr(x, "name") ?? "", cells: ins.map((i) => attr(i, "r") ?? ""), vals: ins.map((i) => attr(i, "val") ?? ""), ...(attr(x, "comment") ? { comment: attr(x, "comment")! } : {}), ...(attr(x, "user") ? { user: attr(x, "user")! } : {}) };
    });
    if (list.length) sh.scenarios = { ...(attr(scs, "current") != null ? { cur: Number(attr(scs, "current")) } : {}), list };
  }
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
    // the threads themselves (with their authors from the workbook's persons part)
    const th = readThreads(x, readPersons(read("xl/persons/person.xml")));
    if (Object.keys(th).length) sh.threads = { ...(sh.threads ?? {}), ...th };
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
    if (bool(attr(dv, "showInputMessage"))) v.showInput = true;
    const pt = attr(dv, "promptTitle");
    if (pt) v.promptTitle = pt;
    const pm = attr(dv, "prompt");
    if (pm) v.prompt = pm;
    if (dv.namespaceURI !== root.namespaceURI) v.x14 = true;
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

  // sparklines (x14:sparklineGroups in extLst)
  const sparks: NonNullable<SheetData["sparks"]> = [];
  for (const sg of descendants(root, "sparklineGroup")) {
    const type = attr(sg, "type");
    const rgb = (n: string) => {
      const e = descendants(sg, n)[0];
      const v = e && attr(e, "rgb");
      return v ? "#" + v.slice(-6).toUpperCase() : undefined;
    };
    const items = descendants(sg, "sparkline").flatMap((sp) => {
      const f = descendants(sp, "f")[0], at = descendants(sp, "sqref")[0];
      return f && at ? [{ at: textOf(at).trim().toUpperCase(), ref: textOf(f).trim() }] : [];
    });
    if (!items.length) continue;
    const g: SheetSparkGroup = { type: type === "column" || type === "stacked" ? type : "line", color: rgb("colorSeries") ?? "#376092", items };
    const neg = rgb("colorNegative");
    if (neg && attr(sg, "negative") === "1") g.negColor = neg;
    if (attr(sg, "markers") === "1") g.markers = true;
    sparks.push(g);
  }
  if (sparks.length) sh.sparks = sparks;

  // hyperlinks (a web / file address through the sheet's relationships, or a place in the workbook)
  const hl = child(root, "hyperlinks");
  const links: Record<string, SheetLink> = {};
  for (const h of hl ? children(hl, "hyperlink") : []) {
    const ref = (attr(h, "ref") ?? "").toUpperCase().replace(/\$/g, "");
    if (!ref) continue;
    const rid = attr(h, "r:id") ?? h.getAttributeNS?.("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id") ?? null;
    const l: SheetLink = {};
    const rel = rid ? rels.get(rid) : undefined;
    if (rel) l.url = rel.target;
    const loc = attr(h, "location");
    if (loc) l.loc = loc;
    const tip = attr(h, "tooltip");
    if (tip) l.tip = tip;
    if (l.url || l.loc) links[ref.split(":")[0]] = l;
  }
  if (Object.keys(links).length) sh.links = links;

  // sheet protection: what stays allowed (an attribute "0" lifts a protection that is on by default; select* are
  // allowed unless "1")
  const sp = child(root, "sheetProtection");
  if (sp && bool(attr(sp, "sheet"))) {
    const allow: string[] = [];
    if (!bool(attr(sp, "selectLockedCells"))) allow.push("selectLocked");
    if (!bool(attr(sp, "selectUnlockedCells"))) allow.push("selectUnlocked");
    for (const k of PROTECT_KEYS) if (attr(sp, k) != null && !bool(attr(sp, k))) allow.push(k);
    sh.protect = { allow, ...(attr(sp, "password") ? { hash: attr(sp, "password")!.toUpperCase() } : {}) };
  }

  // AutoFilter
  const af = child(root, "autoFilter");
  const ref = af && attr(af, "ref");
  if (af && ref) {
    const f: SheetFilter = { ref: ref.replace(/\$/g, "").toUpperCase() };
    for (const fc of children(af, "filterColumn")) {
      const id = Number(attr(fc, "colId") ?? 0);
      const fs = child(fc, "filters");
      f.cols ??= {};
      const cf = child(fc, "customFilters");
      if (cf && children(fc).length === 1) {
        const items = children(cf, "customFilter").map((x) => ({ op: (attr(x, "operator") ?? "equal") as NonNullable<SheetCustomFilter>["items"][number]["op"], val: attr(x, "val") ?? "" }));
        f.cols[id] = { custom: { ...(bool(attr(cf, "and")) ? { and: true } : {}), items } };
        continue;
      }
      const other = children(fc).some((k) => k.localName !== "filters") || !fs || children(fs).some((k) => k.localName !== "filter");
      if (other || !fs) f.cols[id] = { other: true };
      else f.cols[id] = { vals: children(fs, "filter").map((x) => attr(x, "val") ?? ""), ...(bool(attr(fs, "blank")) ? { blank: true } : {}) };
    }
    sh.filter = f;
  }
}
