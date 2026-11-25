// 메모 스레드 (Excel 365 threaded comments): a conversation on a cell — the first comment, its replies, 해결됨.
// File: xl/threadedComments/threadedCommentN.xml (from the sheet), xl/persons/person.xml (from the workbook), and a
// legacy comment for each thread in the comments part (author "tc={id}") that older Excel shows instead.
import type { SheetData, SheetThread } from "../../core/sheetTypes";
import { esc } from "../xml";
import type { PkgRels } from "./writeDrawings";

const TC_NS = "http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments";
const TC_REL = "http://schemas.microsoft.com/office/2017/10/relationships/threadedComment";
const PERSON_REL = "http://schemas.microsoft.com/office/2017/10/relationships/person";
const TC_CT = "application/vnd.ms-excel.threadedcomments+xml";
const PERSON_CT = "application/vnd.ms-excel.person+xml";

/** A GUID in Excel's form ({8-4-4-4-12}, upper case) from a text: the same name gives the same person id. */
export function guidOf(seed: string): string {
  let h1 = 0x811c9dc5, h2 = 0x12345678, h3 = 0x9e3779b9, h4 = 0x7f4a7c15;
  for (let i = 0; i < seed.length; i++) {
    const c = seed.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    h3 = Math.imul(h3 ^ c, 3266489917) >>> 0;
    h4 = Math.imul(h4 ^ c, 668265263) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((x) => x.toString(16).padStart(8, "0")).join("").toUpperCase();
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}}`;
}

/** The text older Excel shows for a thread (the legacy comment Excel writes beside it). */
export function legacyText(th: SheetThread): string {
  const body = th.items.map((x, i) => (i ? `Reply:\n    ${x.text}` : `Comment:\n    ${x.text}`)).join("\n");
  return `[Threaded comment]\n\nYour version of Excel allows you to read this threaded comment; however, any edits to it will get removed if the file is opened in a newer version of Excel. Learn more: https://go.microsoft.com/fwlink/?linkid=870924\n\n${body}`;
}

/** Threads read from a sheet's threadedComments part (persons: id → display name). */
export function readThreads(x: string, persons: Map<string, string>): Record<string, SheetThread> {
  const out: Record<string, SheetThread> = {};
  const byId = new Map<string, SheetThread>();
  for (const m of x.matchAll(/<(?:\w+:)?threadedComment\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?threadedComment>)/g)) {
    const at = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(m[1])?.[1];
    const ref = (at("ref") ?? "").toUpperCase();
    const id = at("id") ?? "";
    const text = /<(?:\w+:)?text>([\s\S]*?)<\/(?:\w+:)?text>/.exec(m[2] ?? "")?.[1] ?? "";
    const item = { id, author: persons.get(at("personId") ?? "") ?? "", text: text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"), date: at("dT") ?? "" };
    const parent = at("parentId");
    const th = parent ? byId.get(parent) : undefined;
    if (th) th.items.push(item);
    else if (ref) {
      const t: SheetThread = { id, items: [item], ...(/^(1|true)$/.test(at("done") ?? "") ? { done: true } : {}) };
      out[ref] = t;
      byId.set(id, t);
    }
  }
  return out;
}

export function readPersons(x: string | null | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of (x ?? "").matchAll(/<(?:\w+:)?person\b([^>]*)\/?>/g)) {
    const id = /\sid="([^"]*)"/.exec(p[1])?.[1], name = /\sdisplayName="([^"]*)"/.exec(p[1])?.[1];
    if (id) m.set(id, (name ?? "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  return m;
}

/**
 * The sheet's threads written: its threadedComments part (made or replaced). Authors get their person id from
 * `persons` (id → name, added to; the workbook's persons part is written by the caller with personsXml).
 */
export function writeThreads(sh: SheetData, o: SheetData | null, pkg: PkgRels, persons: Map<string, string>): boolean {
  const threads = sh.threads ?? {};
  if (o && JSON.stringify(threads) === JSON.stringify(o.threads ?? {})) return false;
  const rel = pkg.rels(pkg.part).find((r) => r.type === "threadedComment" || r.type === TC_REL);
  if (!Object.keys(threads).length && !rel) return false;
  const idOf = (name: string) => {
    for (const [id, n] of persons) if (n === name) return id;
    const id = guidOf("person:" + name);
    persons.set(id, name);
    return id;
  };
  const list = Object.entries(threads)
    .flatMap(([ref, th]) =>
      th.items.map((it, i) => `<threadedComment ref="${ref}" dT="${esc(it.date || "2026-01-01T00:00:00.00")}" personId="${idOf(it.author || "Omniweave")}" id="${it.id}"${i ? ` parentId="${th.id}"` : th.done ? ' done="1"' : ""}><text>${esc(it.text)}</text></threadedComment>`),
    )
    .join("");
  const x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ThreadedComments xmlns="${TC_NS}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${list}</ThreadedComments>`;
  const tPath = rel?.target ?? pkg.freeName((n) => `xl/threadedComments/threadedComment${n}.xml`);
  pkg.setPart(tPath, x, TC_CT);
  if (!rel) pkg.addRel(pkg.part, TC_REL, tPath);
  return true;
}

/** The workbook's persons part (the authors of threaded comments). */
export const personsXml = (persons: Map<string, string>) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<personList xmlns="${TC_NS}" xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${[...persons].map(([id, n]) => `<person displayName="${esc(n)}" id="${id}" userId="${esc(n)}" providerId="None"/>`).join("")}</personList>`;
export { PERSON_REL, PERSON_CT };
