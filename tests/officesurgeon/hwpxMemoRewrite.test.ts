// HWPX memos (한글 메모) on the full rewrite (io/office.ts exportHwpx — the save without the original package, with its
// notice): memo text, author, time, the text each covers (also over paragraphs and in a footnote), the memo box
// (hh:memoPr) and the 메모 style of the memo paragraphs, with every referenced id present and no field id repeated.
// Test file: qa/interop/hancom-made/omni-hwp-memo.hwpx (한글 2024, author 'Omniweave QA'), and a variant made from it
// here (omw-memo-variant: a memo box of its own on the section, a memo of two paragraphs over two body paragraphs).

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { docComments, setReviewAuthor } from "../../src/core/review";
import { newComment, tagComment, withComments } from "../../src/core/reviewEdit";
import type { DocComment, OmwDocument, Page, TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { exportDocx, exportHwpx } from "../../src/io/office";
import { installDom } from "../coverage/helpers";

const MEMO = "qa/interop/hancom-made/omni-hwp-memo.hwpx";
const NOTES = "qa/interop/hancom-made/omni-hwp-notes.hwpx";
const WORD = "qa/interop/word-made/omni-review-comments.docx";
const QA = "Omniweave QA";
const BOX = { width: "18000", lineWidth: "2", lineType: "DASH", lineColor: "#E0A030", fillColor: "#FFF4D6", activeColor: "#FFE7A8", memoType: "NOMAL" };

afterEach(() => setReviewAuthor(""));

const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
async function open(kind: "hwpx" | "docx", bytes: Uint8Array): Promise<OmwDocument> {
  installDom();
  const r = await formatForExt(kind)!.open({ name: `omw-memo.${kind}`, path: null, bytes }, {} as any);
  return docOf(r.pages!, (r as any).assets ?? {});
}
const file = (f: string) => new Uint8Array(readFileSync(f));

/** the save of a document whose original package is gone (an older .omw, its first page deleted): written anew */
async function rewrite(doc: OmwDocument) {
  const msgs: string[] = [];
  const pages = doc.pages.map((p) => (p.source ? { ...p, source: { ...p.source, office: undefined } } : p));
  const out = (await exportById("hwpx")!.run({ ...doc, pages }, pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
  return { out, msgs };
}
async function surgical(doc: OmwDocument) {
  return (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
}

/** every paragraph of the document in order: flow and other text, table cells, then each note's paragraphs */
function allParas(pages: Page[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  const add = (ps: readonly TextParagraph[]) => {
    for (const p of ps) {
      out.push(p);
      for (const r of p.runs) if (r.note) add(r.note.paras);
    }
  };
  for (const pg of pages)
    for (const n of pg.nodes) {
      if (n.type === "TEXT" && !n.notes) add(n.paragraphs);
      if (n.type === "TABLE") for (const row of n.rows) for (const c of row) add(c.richText ?? []);
    }
  return out;
}
/** the text each memo covers (its pieces in each paragraph joined by "|") */
function anchors(pages: Page[]): Map<string, string> {
  const m = new Map<string, string[]>();
  for (const p of allParas(pages)) {
    const per = new Map<string, string>();
    for (const r of p.runs) for (const id of r.comments ?? []) per.set(id, (per.get(id) ?? "") + r.text);
    for (const [id, s] of per) m.set(id, [...(m.get(id) ?? []), s]);
  }
  return new Map([...m].map(([id, v]) => [id, v.join("|")]));
}
/** the memos as the user sees them, in order: text, author, time (한글's memo time: the clock time with a "Z"), box, covered text */
function seen(pages: Page[]) {
  const a = anchors(pages);
  return docComments(pages).map((c) => ({ text: c.text, author: c.author, date: (c.date ?? "").replace(/Z$/, ""), shape: c.shape ?? null, anchor: a.get(c.id) ?? "" }));
}

const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
const sectionsOf = (b: Uint8Array) => Object.entries(unzipSync(b)).filter(([k]) => /^Contents\/section\d+\.xml$/.test(k)).map(([, v]) => strFromU8(v));
const ids = (xml: string, re: RegExp) => Array.from(xml.matchAll(re), (m) => m[1]);

/** the package is whole: XML well-formed, every shape / style / memo box named exists, memo fields begin once and end once */
function checkPackage(b: Uint8Array) {
  for (const [name, data] of Object.entries(unzipSync(b)))
    if (/\.(xml|hpf)$/.test(name)) {
      const errors: string[] = [];
      new DOMParser({ errorHandler: { warning: (m: string) => void errors.push(m), error: (m: string) => void errors.push(m), fatalError: (m: string) => void errors.push(m) } } as any).parseFromString(strFromU8(data), "text/xml");
      expect(errors, name).toEqual([]);
      expect(/[\u0001-\u0004]/.test(strFromU8(data)), `${name}: no placeholder left`).toBe(false);
    }
  const h = part(b, "Contents/header.xml");
  const has = (tag: string) => new Set(ids(h, new RegExp(`<hh:${tag}\\b[^>]*?\\sid="(\\d+)"`, "g")));
  const charPr = has("charPr"), paraPr = has("paraPr"), style = has("style"), memoPr = has("memoPr");
  // itemCnt of the lists the memos touch
  for (const [list, tag] of [["styles", "style"], ["memoProperties", "memoPr"], ["charProperties", "charPr"], ["paraProperties", "paraPr"]]) {
    const m = new RegExp(`<hh:${list} itemCnt="(\\d+)">([\\s\\S]*?)</hh:${list}>`).exec(h);
    if (m) expect(Number(m[1]), list).toBe((m[2].match(new RegExp(`<hh:${tag}\\b`, "g")) ?? []).length);
  }
  const s = sectionsOf(b).join("");
  for (const id of ids(s, /\bcharPrIDRef="(\d+)"/g)) expect(charPr.has(id), `charPr ${id}`).toBe(true);
  for (const id of ids(s, /\bparaPrIDRef="(\d+)"/g)) expect(paraPr.has(id), `paraPr ${id}`).toBe(true);
  for (const id of ids(s, /\bstyleIDRef="(\d+)"/g)) expect(style.has(id), `style ${id}`).toBe(true);
  for (const id of ids(s, /\bmemoShapeIDRef="(\d+)"/g)) expect(id === "0" || memoPr.has(id), `section memo box ${id}`).toBe(true);
  for (const id of ids(s, /name="MemoShapeIDRef">(\d+)</g)) expect(id === "65535" || memoPr.has(id), `memo box ${id}`).toBe(true);
  const begins = ids(s, /<hp:fieldBegin\b[^>]*\bid="(\d+)"[^>]*type="MEMO"/g);
  expect(new Set(begins).size, "memo field ids unique").toBe(begins.length);
  const ends = ids(s, /<hp:fieldEnd beginIDRef="(\d+)"/g);
  expect([...ends].sort()).toEqual([...begins].sort());
  // each field ends after it begins
  for (const id of begins) expect(s.indexOf(`beginIDRef="${id}"`)).toBeGreaterThan(s.indexOf(`<hp:fieldBegin id="${id}"`));
  // memo numbers unique too
  const nums = ids(s, /<hp:integerParam name="Number">(\d+)</g);
  expect(new Set(nums).size).toBe(nums.length);
  // each field ends in the story it begins in (its section part, not inside / outside a table cell, note or header)
  for (const [id, v] of Object.entries(stories(b))) expect(v.end, `memo field ${id} ends where it begins`).toBe(v.begin);
  return { header: h, section: s, begins };
}

/** the story (section part and hp:subList path) of each memo field's begin and end — QA hwpx-memo */
function stories(b: Uint8Array) {
  const res: Record<string, { begin?: string; end?: string }> = {};
  for (const [name, data] of Object.entries(unzipSync(b))) {
    if (!/^Contents\/section\d+\.xml$/.test(name)) continue;
    const stack: number[] = [];
    let n = 0;
    for (const m of strFromU8(data).matchAll(/<hp:subList\b[^>]*?(\/?)>|<\/hp:subList>|<hp:fieldBegin\b[^>]*>|<hp:fieldEnd\b[^>]*>/g)) {
      const t = m[0];
      const at = `${name}:${stack.join("/")}`;
      if (t.startsWith("<hp:subList")) {
        if (!m[1]) stack.push(++n);
      } else if (t.startsWith("</")) stack.pop();
      else if (t.startsWith("<hp:fieldBegin")) (res[/\bid="(\d+)"/.exec(t)![1]] ??= {}).begin = at;
      else (res[/beginIDRef="(\d+)"/.exec(t)![1]] ??= {}).end = at;
    }
  }
  return res;
}

/** omni-hwp-memo with memo 2 ('부서 이름을 적어 주세요') on no text: its field begun and ended right after "각 부서" */
function pointVariant(): Uint8Array {
  const z = unzipSync(file(MEMO));
  let s = strFromU8(z["Contents/section0.xml"]);
  const f = /<hp:ctrl><hp:fieldBegin id="1248135444"[\s\S]*?<\/hp:ctrl>/.exec(s)![0];
  s = s.replace(f, "").replace(/<hp:ctrl><hp:fieldEnd beginIDRef="1248135444"/, (m) => f + m);
  return zipSync({ ...z, "Contents/section0.xml": strToU8(s) });
}
/** a section's text with each memo field's begin as [B] and end as [E] */
const flat = (section: string) =>
  section
    .replace(/<hp:fieldBegin\b[^>]*type="MEMO"[\s\S]*?<\/hp:fieldBegin>/g, "[B]")
    .replace(/<hp:fieldEnd\b[^>]*\/>/g, "[E]")
    .replace(/<[^>]+>/g, "");

/**
 * omni-hwp-memo with, in 한글's own markup: a memo box of its own (hh:memoPr 1, named by the section like 한글 does for
 * a new section), and memo 4 of two paragraphs from "대응 방안" in the second body paragraph to "마지막 문단은" in the third.
 */
function variant(): Uint8Array {
  const z = unzipSync(file(MEMO));
  let h = strFromU8(z["Contents/header.xml"]);
  const box = `<hh:memoProperties itemCnt="1"><hh:memoPr id="1" ${Object.entries(BOX).map(([k, v]) => `${k}="${v}"`).join(" ")}/></hh:memoProperties>`;
  h = h.replace("</hh:styles>", `</hh:styles>${box}`);
  let s = strFromU8(z["Contents/section0.xml"]);
  s = s.replace('memoShapeIDRef="0"', 'memoShapeIDRef="1"');
  const memoP = (t: string) => `<hp:p id="0" paraPrIDRef="11" styleIDRef="17" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="4"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  const field =
    `<hp:ctrl><hp:fieldBegin id="1248135450" type="MEMO" name="" editable="1" dirty="1" zorder="4" fieldid="623209829" metaTag=""><hp:parameters cnt="7" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">MEMO/65535/4/780723216/31290604/${QA}/\\;;</hp:stringParam><hp:stringParam name="ID">memo4</hp:stringParam><hp:integerParam name="Number">4</hp:integerParam><hp:stringParam name="Author">${QA}</hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535</hp:stringParam><hp:stringParam name="CreateDateTime">2026-11-16T09:15:00Z</hp:stringParam></hp:parameters>` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${memoP("오메 시험 메모 4 — 두 문단에 걸친 메모입니다.")}${memoP("둘째 줄: 대응 방안 예시를 넣어 주세요.")}</hp:subList></hp:fieldBegin></hp:ctrl>`;
  expect(s).toContain("위험 요소와 대응 방안을");
  s = s.replace("위험 요소와 대응 방안을", `위험 요소와 </hp:t>${field}<hp:t>대응 방안을`);
  s = s.replace("<hp:t>마지막 문단은 ", `<hp:t>마지막 문단은</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1248135450" fieldid="623209829"/></hp:ctrl><hp:t> `);
  return zipSync({ ...z, "Contents/header.xml": strToU8(h), "Contents/section0.xml": strToU8(s) });
}

describe("HWPX memos on the full rewrite", () => {
  it("the 한글 file: memos read with their box, text over two paragraphs and in a table cell", async () => {
    const doc = await open("hwpx", variant());
    const v = seen(doc.pages);
    expect(v.map((m) => m.anchor)).toEqual(["매출과 비용, 다음 분기의 계획", "각 부서", "대응 방안을 함께 적어 주시기 바랍니다.|마지막 문단은", expect.stringContaining("")]);
    expect(v[2].text).toBe("오메 시험 메모 4 — 두 문단에 걸친 메모입니다.\n둘째 줄: 대응 방안 예시를 넣어 주세요.");
    expect(v[2].date).toBe("2026-11-16T09:15:00");
    for (const m of v) expect(m.shape).toEqual(BOX);
    // without a memo box of its own (한글 2024's default): none
    expect(docComments((await open("hwpx", file(MEMO))).pages).every((c) => !c.shape)).toBe(true);
  });

  it("open → written anew (with its notice) → open: the same memos, texts, authors, times, boxes and covered text", async () => {
    const doc = await open("hwpx", variant());
    const before = seen(doc.pages);
    expect(before.length).toBe(4);
    const { out, msgs } = await rewrite(doc);
    expect(msgs.length).toBeGreaterThan(0); // the notice of the save written anew
    const back = await open("hwpx", out);
    expect(seen(back.pages)).toEqual(before);
    const { header, section, begins } = checkPackage(out);
    expect(begins.length).toBe(4);
    // the memo box: in the header, the section names it, the memos follow the section (65535) as 한글 writes them
    expect(header).toMatch(/<hh:memoProperties itemCnt="1"><hh:memoPr id="1" width="18000" lineWidth="2" lineType="DASH" lineColor="#E0A030" fillColor="#FFF4D6" activeColor="#FFE7A8" memoType="NOMAL"\/><\/hh:memoProperties>/);
    expect(section).toContain('memoShapeIDRef="1"');
    expect(ids(section, /name="MemoShapeIDRef">(\d+)</g)).toEqual(["65535", "65535", "65535", "65535"]);
    // memo paragraphs in the 메모 style: 9 pt, 자간 -5, 130 %
    const memoStyle = /<hh:style id="(\d+)" type="PARA" name="메모" engName="Memo" paraPrIDRef="(\d+)" charPrIDRef="(\d+)"/.exec(header)!;
    expect(memoStyle).toBeTruthy();
    const subs = Array.from(section.matchAll(/<hp:fieldBegin\b[\s\S]*?<\/hp:fieldBegin>/g), (m) => m[0]);
    for (const f of subs) {
      const ps = Array.from(f.matchAll(/<hp:p id="0" paraPrIDRef="(\d+)" styleIDRef="(\d+)"[^>]*><hp:run charPrIDRef="(\d+)"/g));
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps) expect([p[1], p[2], p[3]]).toEqual([memoStyle[2], memoStyle[1], memoStyle[3]]);
    }
    const cp = new RegExp(`<hh:charPr id="${memoStyle[3]}" height="900"[^>]*>[\\s\\S]*?<hh:spacing hangul="-5"`).exec(header);
    expect(cp).toBeTruthy();
    expect(header).toMatch(new RegExp(`<hh:paraPr id="${memoStyle[2]}"[\\s\\S]*?<hh:lineSpacing type="PERCENT" value="130"`));
    // the memo over two paragraphs: one field, begun in the second body paragraph and ended in the third
    const f4 = /<hp:fieldBegin id="(\d+)"[^>]*>(?:(?!<\/hp:fieldBegin>)[\s\S])*오메 시험 메모 4/.exec(section)!;
    const from = section.indexOf(f4[0]), to = section.indexOf(`beginIDRef="${f4[1]}"`);
    expect(section.slice(from, to)).toContain("</hp:p>");
    // written twice: the same bytes. (The zip entries carry the save time in DOS 2-second steps — fflate's Date.now() —
    // so the two writes are made at one frozen clock: under load they could otherwise fall either side of a step.)
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 0));
      const a = (await rewrite(doc)).out;
      vi.setSystemTime(new Date(2026, 10, 17, 9, 0, 1)); // the same 2-second step
      const b = (await rewrite(doc)).out;
      expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
      // and the content (every entry) matches the first write made at the real time
      const za = unzipSync(a), zo = unzipSync(out);
      expect(Object.keys(za)).toEqual(Object.keys(zo));
      for (const k of Object.keys(zo)) expect(Buffer.from(za[k]).equals(Buffer.from(zo[k])), k).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the 한글 2024 file (no memo box): memos follow 한글's default box, nothing named that is not there", async () => {
    const doc = await open("hwpx", file(MEMO));
    const before = seen(doc.pages);
    const { out } = await rewrite(doc);
    expect(seen((await open("hwpx", out)).pages)).toEqual(before);
    const { header, section } = checkPackage(out);
    expect(header).not.toContain("memoProperties");
    expect(ids(section, /\bmemoShapeIDRef="(\d+)"/g).every((v) => v === "0")).toBe(true);
  });

  it("a memo made and one edited in Omniweave are written in the same form, then read back", async () => {
    setReviewAuthor(QA);
    const doc = await open("hwpx", variant());
    const c = newComment("오메에서 단 메모 — 회의 날짜를 적어 주세요.");
    let tagged = false;
    const tag = (ps: TextParagraph[]): TextParagraph[] => {
      const p = ps.findIndex((q) => q.runs.map((r) => r.text).join("").includes("다음 회의 안건"));
      if (p < 0 || tagged) return ps;
      tagged = true;
      const o = ps[p].runs.map((r) => r.text).join("").indexOf("다음 회의 안건");
      return tagComment(ps, { start: { p, o }, end: { p, o: o + "다음 회의 안건".length } }, c.id)!;
    };
    const pages = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: tag(n.paragraphs) } : n)) }));
    expect(tagged).toBe(true);
    const list = docComments(pages).map((x, i) => (i === 0 ? { ...x, text: "고친 메모 1\n둘째 줄" } : x));
    const edited = docOf(withComments(pages, [...list, c]), doc.assets);
    const before = seen(edited.pages);
    expect(before.find((m) => m.text.startsWith("오메에서 단 메모"))!.anchor).toBe("다음 회의 안건");
    const { out } = await rewrite(edited);
    // (in document order on reopening; a memo made here has no box of its own: it shows the section's, as in 한글)
    const byText = (v: ReturnType<typeof seen>) => [...v].sort((a, b) => a.text.localeCompare(b.text));
    expect(byText(seen((await open("hwpx", out)).pages))).toEqual(byText(before.map((m) => ({ ...m, shape: m.shape ?? BOX }))));
    const { section } = checkPackage(out);
    // the new memo: 한글's field (number after the others, author, time)
    expect(section).toMatch(/<hp:stringParam name="Author">Omniweave QA<\/hp:stringParam><hp:stringParam name="MemoShapeIDRef">65535<\/hp:stringParam><hp:stringParam name="CreateDateTime">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ</);
  });

  it("a memo held in pieces (text between not covered) is written as one field; a memo over two footnote paragraphs too", async () => {
    // in pieces: memo 2 on "각 부서" and again on "목표"
    const doc = await open("hwpx", file(MEMO));
    const id2 = docComments(doc.pages)[1].id;
    for (const p of allParas(doc.pages)) for (const r of p.runs) if (r.text.includes("실적을 바탕으로 목표를")) r.comments = [id2];
    let { out } = await rewrite(doc);
    let pk = checkPackage(out);
    expect(pk.begins.length).toBe(3);
    // footnote: a memo over both paragraphs of a note
    const nd = await open("hwpx", file(NOTES));
    const note = allParas(nd.pages).flatMap((p) => p.runs).find((r) => r.note)!.note!;
    if (note.paras.length < 2) note.paras.push({ ...note.paras[0], id: "p-omw-2", runs: [{ ...note.paras[0].runs[note.paras[0].runs.length - 1], text: "오메 둘째 각주 문단", noteMark: undefined }] });
    setReviewAuthor(QA);
    const c = newComment("각주 메모");
    for (const p of note.paras.slice(0, 2)) for (const r of p.runs) if (!r.noteMark && r.text) r.comments = [c.id];
    const noted = docOf(withComments(nd.pages, [...docComments(nd.pages), c]), nd.assets);
    const before = seen(noted.pages);
    ({ out } = await rewrite(noted));
    pk = checkPackage(out);
    expect(pk.begins.length).toBe(1);
    expect(seen((await open("hwpx", out)).pages)).toEqual(before);
  });

  it("DOCX comments → HWPX written anew → back: texts, authors, covered text; HWPX memos → DOCX → back", async () => {
    const w = await open("docx", file(WORD));
    const wc = docComments(w.pages);
    expect(wc.length).toBeGreaterThan(0);
    const notes: string[] = [];
    const h = exportHwpx(w.pages, "t", { assets: w.assets, notes });
    checkPackage(h);
    const hb = await open("hwpx", h);
    const key = (v: ReturnType<typeof seen>) => v.map((m) => [m.text, m.author, m.anchor]).sort();
    // (a reply has no place in HWPX: it is written as a memo of its own on the same text, with a notice)
    expect(key(seen(hb.pages))).toEqual(key(seen(w.pages)));
    if (wc.some((c) => c.parent)) expect(notes.length).toBeGreaterThan(0);
    // HWPX → DOCX: the memo box is 한글's only, the rest as Word comments
    const hv = await open("hwpx", variant());
    const d = exportDocx(hv.pages, { assets: hv.assets });
    const db = await open("docx", d);
    const strip = (v: ReturnType<typeof seen>) => v.map(({ shape: _s, ...m }) => m);
    expect(strip(seen(db.pages))).toEqual(strip(seen(hv.pages)));
  });

  it("the Office Surgeon is unchanged: an edit beside a memo keeps the file's memo fields byte for byte, no memo box added", async () => {
    const orig = file(MEMO);
    const doc = await open("hwpx", orig);
    for (const p of allParas(doc.pages)) for (const r of p.runs) if (r.text.startsWith("마지막 문단은")) r.text = r.text.replace("마지막", "마지막(QA)");
    const out = await surgical(doc);
    const fields = (b: Uint8Array) => Array.from(part(b, "Contents/section0.xml").matchAll(/<hp:ctrl><hp:field(?:Begin|End)\b[\s\S]*?<\/hp:ctrl>/g), (m) => m[0]);
    expect(fields(out)).toEqual(fields(orig));
    expect(part(out, "Contents/section0.xml")).toContain("마지막(QA)");
    expect(part(out, "Contents/header.xml")).not.toContain("memoProperties");
  });

  it("QA: a memo from body text into a table cell, or over two cells, never ends in another story than it begins", async () => {
    const doc = await open("hwpx", file(MEMO));
    setReviewAuthor(QA);
    const a = newComment("QA 본문에서 표 칸으로 걸친 메모");
    const b = newComment("QA 두 칸에 걸친 메모");
    const ps = allParas(doc.pages);
    const tag = (text: string, id: string) => {
      const p = ps.find((q) => q.runs.map((r) => r.text).join("") === text) ?? ps.find((q) => q.runs.some((r) => r.text.includes(text)))!;
      for (const r of p.runs) if (r.text) r.comments = [...(r.comments ?? []), id];
    };
    tag("마지막 문단은", a.id); // body, then the table's first cell
    tag("항목", a.id);
    tag("금액", b.id); // two cells
    tag("매출", b.id);
    const d = docOf(withComments(doc.pages, [...docComments(doc.pages), a, b]), doc.assets);
    const notes: string[] = [];
    const out = exportHwpx(d.pages, "t", { assets: d.assets, notes });
    const { begins } = checkPackage(out);
    expect(begins.length).toBe(5);
    // (each keeps the text of the story it begins in)
    const back = seen((await open("hwpx", out)).pages);
    expect(back.find((m) => m.text === a.text)!.anchor).toBe("마지막 문단은 검토 의견을 모아 다음 회의 안건으로 넘깁니다.");
    expect(back.find((m) => m.text === b.text)!.anchor).toBe("금액");
  });

  it("QA: a memo on no text is kept at its place — read, written anew, surgical save of its edited paragraph, DOCX", async () => {
    const doc = await open("hwpx", pointVariant());
    const memos = docComments(doc.pages);
    expect(memos.map((c) => c.text)).toEqual(["오메 시험 메모 1 — 숫자 출처를 각주로 달아 주세요.", "오메 시험 메모 2 — 부서 이름을 적어 주세요.", "오메 시험 메모 3 — 표 칸 안 메모입니다."]);
    expect(memos[1].at?.offset).toBe(4);
    expect(seen(doc.pages)[1].anchor).toBe("");
    // written anew: the field begun and ended after "각 부서"
    const { out } = await rewrite(doc);
    const pk = checkPackage(out);
    expect(pk.begins.length).toBe(3);
    expect(flat(pk.section)).toContain("각 부서[B][E]는 지난");
    const back = docComments((await open("hwpx", out)).pages);
    expect(back.map((c) => [c.text, c.at?.offset ?? null])).toEqual(memos.map((c) => [c.text, c.at?.offset ?? null]));
    // the Office Surgeon: its paragraph edited after the memo's place
    const ed = await open("hwpx", pointVariant());
    for (const p of allParas(ed.pages)) for (const r of p.runs) if (r.text.includes("다시 세우고")) r.text = r.text.replace("다시 세우고", "다시(QA) 세우고");
    const sg = await surgical(ed);
    const s = part(sg, "Contents/section0.xml");
    expect(s).toContain("다시(QA) 세우고");
    expect(flat(s)).toContain("각 부서[B][E]는 지난");
    expect(s.match(/<hp:fieldBegin\b/g)!.length).toBe(3);
    expect(docComments((await open("hwpx", sg)).pages).map((c) => c.text)).toEqual(memos.map((c) => c.text));
    // DOCX: a comment range of no text at the same place
    const dx = exportDocx(doc.pages, { assets: doc.assets });
    expect(strFromU8(unzipSync(dx)["word/document.xml"]).replace(/<w:r>(?:(?!<w:r>)[\s\S])*?<w:commentReference[^>]*\/><\/w:r>/g, "[R]").replace(/<w:commentRange(Start|End)[^>]*\/>/g, (_, k: string) => (k === "Start" ? "[S]" : "[E]")).replace(/<[^>]+>/g, "")).toContain("각 부서[S][E][R]는 지난");
    expect(docComments((await open("docx", dx)).pages).map((c) => c.text)).toEqual(memos.map((c) => c.text));
  });

  it("QA: memo author and text with XML characters, Korean, tabs and control characters", async () => {
    const doc = await open("hwpx", file(MEMO));
    const list = docComments(doc.pages).map((x, i) => (i === 0 ? { ...x, author: `QA & <"오메"> 'x'`, text: `a<b>&"c'\t탭\u0007벨\r\n둘째 줄` } : x));
    const { out } = await rewrite(docOf(withComments(doc.pages, list), doc.assets));
    checkPackage(out);
    const back = docComments((await open("hwpx", out)).pages)[0];
    expect([back.author, back.text]).toEqual([`QA & <"오메"> 'x'`, `a<b>&"c'\t탭벨\n둘째 줄`]);
  });

  // a sample for checking in 한글: OMW_SAMPLE_OUT=<folder> writes omw-memo-rewrite.hwpx and memo-check.txt there
  it.runIf(!!process.env.OMW_SAMPLE_OUT)("sample for 한글", async () => {
    setReviewAuthor(QA);
    const doc = await open("hwpx", variant());
    const c = newComment("오메 새 메모 5 — 오메에서 새로 쓰기 저장 때 단 메모입니다.");
    c.date = "2026-11-18T09:00:00";
    let tagged = false;
    const pages = doc.pages.map((pg) => ({
      ...pg,
      nodes: pg.nodes.map((n) => {
        if (n.type !== "TEXT" || !n.flow || tagged) return n;
        const p = n.paragraphs.findIndex((q) => q.runs.map((r) => r.text).join("").includes("다음 회의 안건"));
        if (p < 0) return n;
        tagged = true;
        const o = n.paragraphs[p].runs.map((r) => r.text).join("").indexOf("다음 회의 안건");
        return { ...n, paragraphs: tagComment(n.paragraphs, { start: { p, o }, end: { p, o: o + "다음 회의 안건".length } }, c.id)! };
      }),
    }));
    const edited = docOf(withComments(pages, [...docComments(pages), c]), doc.assets);
    const { out } = await rewrite(edited);
    checkPackage(out);
    const v = seen((await open("hwpx", out)).pages);
    const { writeFileSync } = await import("node:fs");
    const dir = process.env.OMW_SAMPLE_OUT!;
    writeFileSync(`${dir}/omw-memo-rewrite.hwpx`, out);
    const lines = [
      "omw-memo-rewrite.hwpx — 오메 '새로 쓰기' 저장(원본 패키지 없이 다시 만든 HWPX)의 메모 확인",
      "",
      "한글에서 열어 [검토] 메모 창(또는 메모 보이기)으로 아래와 같은지 봅니다.",
      `메모 수: ${v.length}개, 작성자 모두 '${QA}'`,
      "",
      ...v.flatMap((m, i) => [`${i + 1}. 메모 글: ${m.text.replace(/\n/g, " / ")}`, `   붙은 글자: 「${m.anchor.replace(/\|/g, "」 ~ (다음 문단) 「")}」`, `   시각: ${m.date}`]),
      "",
      "함께 볼 것:",
      `- 메모 상자 모양: 모든 메모가 구역에 지정한 상자(hh:memoPr 1 — 너비 18000, 선 굵기 2, 선 종류 DASH, 선 #E0A030, 채움 #FFF4D6, 활성 #FFE7A8)로 보이는지. 한글 기본(연두색 상자)이면 상자 모양이 빠진 것.`,
      "- 메모 글 모양: 9pt 함초롬돋움, 자간 -5%, 줄 간격 130%('메모' 스타일) — 본문 글자 크기로 커지지 않을 것.",
      "- 셋째 메모(시험 메모 4)는 둘째 본문 문단의 '대응 방안을…'부터 셋째 문단 '마지막 문단은'까지 한 메모(두 문단에 걸침), 메모 글은 두 줄.",
      "- 마지막 메모(시험 메모 3)는 표 칸의 '1,234,567'에 붙음.",
      "- 열 때 오류·복구 안내가 없고, 메모를 지우거나 고친 뒤 한글로 저장해도 문제없는지.",
    ];
    writeFileSync(`${dir}/memo-check.txt`, "\ufeff" + lines.join("\r\n") + "\r\n");
  });
});
