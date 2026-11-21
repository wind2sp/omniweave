// QA hwpx-outline (2026-11-18, 문서부): a 한글-made HWPX whose outline (개요) numbering defines levels 1–10 —
// level 7 ① (CIRCLED_DIGIT '^7' checkable), 8 ㉮ (CIRCLED_HANGUL_SYLLABLE), 9 HANGUL_JAMO, 10 ROMAN_SMALL — and a
// 개요 7 heading, a symbol-font bullet (Wingdings 'l', shown ●). Its outline numbering edited (개요 2 as 'A.') goes
// through the full HWPX rewrite: every level nobody changed is written as 한글 wrote it, the 개요 7 heading keeps its
// OUTLINE heading (number ①), the bullet its own character.
import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as RT from "../../src/core/richtext";
import { HWPX_NUMFMT_IN, formatNumber, hwpxFormatNumber, levelNumber, resolveDef } from "../../src/core/lists";
import type { ListDef } from "../../src/core/style/types";
import { newPage, newText, type OmwDocument, type TextNode, type TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { exportHwpx, hwpxHeight } from "../../src/io/office";
import { installDom } from "../coverage/helpers";

const HANCOM = "qa/interop/hancom-made/omni-hwp-numbering.hwpx";
const DOCX = "qa/samples/doc-features/omni-sample.docx";

async function open(path: string, bytes: Uint8Array = new Uint8Array(readFileSync(path))): Promise<OmwDocument> {
  installDom();
  const r = await formatForExt(path.split(".").pop()!)!.open({ name: path, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, ext: string) {
  const msgs: string[] = [];
  const out = (await exportById(ext)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
  return { out, msgs };
}
const nodes = (doc: OmwDocument) => doc.pages.flatMap((p) => [...p.nodes].sort((a, b) => a.transform.y - b.transform.y || a.transform.x - b.transform.x).filter((n): n is TextNode => n.type === "TEXT"));
const paras = (doc: OmwDocument) => nodes(doc).flatMap((n) => n.paragraphs);
const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const find = (doc: OmwDocument, s: string) => {
  const p = paras(doc).find((q) => text(q).slice(RT.markerLength(q)).startsWith(s));
  if (!p) throw new Error("no paragraph " + s);
  return p;
};
const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]);
const numbering = (header: string, id: string) => new RegExp(`<hh:numbering\\b[^>]*\\sid="${id}"[\\s\\S]*?</hh:numbering>`).exec(header)![0];
const heads = (num: string) => Array.from(num.matchAll(/<hh:paraHead\b[^>]*?(?:\/>|>[\s\S]*?<\/hh:paraHead>)/g)).map((m) => m[0]);
const headAt = (num: string, level: number) => heads(num).find((h) => h.includes(` level="${level}"`));

function renumberAll(doc: OmwDocument) {
  let seed: RT.ListSeed | undefined;
  for (const n of nodes(doc)) {
    const r = RT.renumber(n.paragraphs, { defs: n.lists, seed });
    n.paragraphs = r.paras;
    seed = r.seed;
  }
}
function redefineLevel(doc: OmwDocument, defId: string, level: number, patch: Partial<ListDef["levels"][number]>) {
  for (const n of nodes(doc)) {
    if (!n.lists?.some((x) => x.id === defId)) continue;
    n.lists = n.lists!.map((x) => (x.id === defId ? { ...x, levels: x.levels.map((l, i) => (i === level ? { ...l, ...patch } : l)) } : x));
  }
  renumberAll(doc);
}

/** open the 한글 file, 개요 2 as 'A.' (the outline numbering: full rewrite with a notice), open the saved file */
async function outlineEdited() {
  const doc = await open(HANCOM);
  redefineLevel(doc, "hwpx-n1", 1, { format: "upperLetter", text: "%2." });
  const { out, msgs } = await save(doc, "hwpx");
  expect(msgs.length).toBeGreaterThan(0); // the notice of the full rewrite
  return { doc, out, again: await open(HANCOM, out) };
}

describe("hwpx-outline: 한글 outline levels 7–10", () => {
  it("reading: every paraHead level's format, text and start is kept; 개요 7 is numbered ①", async () => {
    const doc = await open(HANCOM);
    const def = nodes(doc).flatMap((n) => n.lists ?? []).find((d) => d.id === "hwpx-n1")!;
    expect(def.levels.slice(6).map((l) => l.hwpx?.fmt)).toEqual(["CIRCLED_DIGIT", "CIRCLED_HANGUL_SYLLABLE", "HANGUL_JAMO"]);
    expect(def.levels[6].text).toBe("%7");
    expect(def.levels[6].hwpx!.raw).toContain('checkable="1"');
    expect(def.hwpxMore?.[0]).toMatch(/level="10"[^>]*numFormat="ROMAN_SMALL"[^>]*checkable="1"/);
    // the marker drawn: ① for 개요 7 (as 한글 shows it)
    const h7 = find(doc, "개요 7 수준");
    expect(h7.list?.level).toBe(6);
    expect(h7.list?.mk).toBe("① ");
    expect(text(h7).startsWith("① 개요 7 수준")).toBe(true);
    // the other levels as before
    expect(find(doc, "개요 1 수준").list?.mk).toBe("1. ");
    expect(find(doc, "개요 2 수준").list?.mk).toBe("가. ");
  });

  it("formats the model has only a nearest name for draw their own glyphs", () => {
    expect([1, 2, 14].map((n) => hwpxFormatNumber(n, "CIRCLED_HANGUL_SYLLABLE"))).toEqual(["㉮", "㉯", "㉻"]);
    expect([1, 3].map((n) => hwpxFormatNumber(n, "CIRCLED_HANGUL_JAMO"))).toEqual(["㉠", "㉢"]);
    expect([1, 2].map((n) => hwpxFormatNumber(n, "CIRCLED_LATIN_CAPITAL"))).toEqual(["Ⓐ", "Ⓑ"]);
    expect([1, 2].map((n) => hwpxFormatNumber(n, "CIRCLED_LATIN_SMALL"))).toEqual(["ⓐ", "ⓑ"]);
    expect([1, 10, 11].map((n) => hwpxFormatNumber(n, "IDEOGRAPH"))).toEqual(["一", "十", "11"]);
    expect([1, 3].map((n) => hwpxFormatNumber(n, "CIRCLED_IDEOGRAPH"))).toEqual(["㊀", "㊂"]);
    expect([1, 2].map((n) => hwpxFormatNumber(n, "HANGUL_PHONETIC"))).toEqual(["일", "이"]);
    expect([1, 3].map((n) => hwpxFormatNumber(n, "HANGUL_JAMO"))).toEqual(["ㄱ", "ㄷ"]);
    expect([4].map((n) => hwpxFormatNumber(n, "ROMAN_SMALL"))).toEqual(["iv"]);
    // a level whose format was changed in the editor: its own format, not the one read
    const lv = { format: "ganada", text: "%8", hwpx: { fmt: "CIRCLED_HANGUL_SYLLABLE", raw: "", format: "ganada", text: "%8" } };
    expect(levelNumber(lv, 2)).toBe("㉯");
    expect(levelNumber({ ...lv, format: "decimal" }, 2)).toBe("2");
  });

  it("full rewrite after 개요 2 → 'A.': levels 7–10 written as 한글 wrote them, only level 2 changed", async () => {
    const { out } = await outlineEdited();
    const orig = numbering(part(new Uint8Array(readFileSync(HANCOM)), "Contents/header.xml"), "1");
    const now = numbering(part(out, "Contents/header.xml"), "1");
    expect(heads(now).length).toBe(10);
    for (const l of [1, 3, 4, 5, 6, 7, 8, 9, 10]) expect(headAt(now, l)).toBe(headAt(orig, l));
    expect(headAt(now, 2)).toBe(headAt(orig, 2)!.replace('numFormat="HANGUL_SYLLABLE"', 'numFormat="LATIN_CAPITAL"'));
    expect(headAt(now, 7)).toContain('numFormat="CIRCLED_DIGIT"');
    expect(headAt(now, 7)).toContain('checkable="1">^7<');
  });

  it("full rewrite: the 개요 7 heading is an OUTLINE paragraph at level 7 again (style 개요 7) and reads back as ①", async () => {
    const { out, again } = await outlineEdited();
    const header = part(out, "Contents/header.xml");
    const section = part(out, "Contents/section0.xml");
    const p = /<hp:p\b[^>]*paraPrIDRef="(\d+)"[^>]*styleIDRef="(\d+)"[^>]*>(?:(?!<hp:p\b)[\s\S])*?개요 7 수준/.exec(section)!;
    expect(p).not.toBeNull();
    const pr = new RegExp(`<hh:paraPr id="${p[1]}"[\\s\\S]*?</hh:paraPr>`).exec(header)![0];
    expect(pr).toContain('<hh:heading type="OUTLINE" idRef="0" level="6"/>');
    expect(new RegExp(`<hh:style id="${p[2]}"[^>]*name="개요 7"`).test(header)).toBe(true);
    // the reopened file
    expect(find(again, "개요 7 수준").list?.mk).toBe("① ");
    expect(find(again, "개요 2 수준").list?.mk).toBe("A. ");
    expect(find(again, "개요 1 수준").list?.mk).toBe("1. ");
    expect(find(again, "개요 6 수준").list?.mk).toBe("(가) ");
    // and its levels 7–10 as the original
    const def = nodes(again).flatMap((n) => n.lists ?? []).find((d) => d.id === "hwpx-n1")!;
    expect(def.levels.slice(6).map((l) => l.hwpx?.raw)).toEqual(
      heads(numbering(part(new Uint8Array(readFileSync(HANCOM)), "Contents/header.xml"), "1")).slice(6, 9),
    );
  });

  it("full rewrite: the bullet keeps its symbol-font character (not Unicode ●)", async () => {
    const { out, again } = await outlineEdited();
    const orig = /<hh:bullet\b[\s\S]*?<\/hh:bullet>/.exec(part(new Uint8Array(readFileSync(HANCOM)), "Contents/header.xml"))![0];
    expect(orig).toContain('char=""');
    const header = part(out, "Contents/header.xml");
    const written = Array.from(header.matchAll(/<hh:bullet\b[\s\S]*?<\/hh:bullet>/g)).map((m) => m[0]);
    const mine = written.find((b) => b.includes(""))!;
    expect(mine).toBe(orig.replace(/\sid="1"/, mine.match(/\sid="\d+"/)![0]));
    expect(header).not.toContain('char="●"');
    // the bulleted paragraphs name that bullet
    const id = /\sid="(\d+)"/.exec(mine)![1];
    expect(header).toContain(`<hh:heading type="BULLET" idRef="${id}" level="0"/>`);
    // shown ● as before
    expect(paras(again).filter((p) => p.role === "li").map((p) => p.list?.mk)).toEqual(["● ", "● ", "● "]);
  });

  // a sample for checking in 한글: OMW_SAMPLE_OUT=<folder> writes omw-outline-fix.hwpx there (개요 2 as 'A.', full rewrite)
  it.runIf(!!process.env.OMW_SAMPLE_OUT)("sample for 한글", async () => {
    const { out } = await outlineEdited();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${process.env.OMW_SAMPLE_OUT}/omw-outline-fix.hwpx`, out);
  });

  it("the bullet changed in the editor is written as the new character", async () => {
    const doc = await open(HANCOM);
    redefineLevel(doc, "hwpx-n1", 1, { format: "upperLetter", text: "%2." });
    redefineLevel(doc, "hwpx-b1", 0, { text: "■" });
    const { out } = await save(doc, "hwpx");
    const header = part(out, "Contents/header.xml");
    expect(header).toContain('char="■"');
    expect(header).not.toContain("");
  });

  it("a level 7 format changed in the editor: numFormat and text set, its other attributes (checkable) kept", async () => {
    const doc = await open(HANCOM);
    redefineLevel(doc, "hwpx-n1", 6, { format: "decimal", text: "%7)" });
    expect(find(doc, "개요 7 수준").list?.mk).toBe("1) ");
    const { out } = await save(doc, "hwpx");
    const now = numbering(part(out, "Contents/header.xml"), "1");
    expect(headAt(now, 7)).toMatch(/numFormat="DIGIT"[^>]*checkable="1">\^7\)<\/hh:paraHead>/);
    const again = await open(HANCOM, out);
    expect(find(again, "개요 7 수준").list?.mk).toBe("1) ");
  });
});

// QA hwpx-outline (2026-11-18, QA부): what the dept's fix must not do
describe("hwpx-outline QA", () => {
  /** the 한글 file with its header changed by `edit` */
  const variant = (edit: (header: string) => string) => {
    const files = unzipSync(new Uint8Array(readFileSync(HANCOM)));
    files["Contents/header.xml"] = strToU8(edit(strFromU8(files["Contents/header.xml"])));
    return zipSync(files);
  };

  it("font sizes: a size the px value holds exactly comes back to the 1/100 pt; 10 pt as 1000 (not 998)", () => {
    // read as HWPX does (0.1 px), written back
    const read = (h: number) => Math.round((h / 100) * (96 / 72) * 10) / 10;
    for (const h of [825, 975, 900, 1000, 1050, 1100, 1200, 1260, 1470, 2400]) expect(hwpxHeight(read(h))).toBe(h);
    for (let h = 100; h <= 7200; h += 10) expect(hwpxHeight(read(h))).toBe(h); // every 0.1 pt step
    expect(hwpxHeight(14 * (96 / 72))).toBe(1400); // a size set in the editor
    expect(hwpxHeight(10.25 * (96 / 72))).toBe(1025);
  });

  it("a number / bullet shape's charPrIDRef is not carried into the rewrite (it would name another charPr)", async () => {
    const bytes = variant((h) =>
      h
        .replace(/(<hh:paraHead\b[^>]*level="7"[^>]*charPrIDRef=")\d+"/, (_, a: string) => a + '3"')
        .replace(/(<hh:paraHead\b[^>]*level="10"[^>]*charPrIDRef=")\d+"/, (_, a: string) => a + '3"')
        .replace(/(<hh:bullet\b[\s\S]*?charPrIDRef=")\d+"/, (_, a: string) => a + '2"'),
    );
    expect(strFromU8(unzipSync(bytes)["Contents/header.xml"])).toMatch(/level="7"[^>]*charPrIDRef="3"/);
    const doc = await open(HANCOM, bytes);
    redefineLevel(doc, "hwpx-n1", 1, { format: "upperLetter", text: "%2." });
    const { out } = await save(doc, "hwpx");
    const header = part(out, "Contents/header.xml");
    const heads = Array.from(header.matchAll(/<hh:(?:paraHead|bullet)\b[^>]*>/g)).map((m) => m[0]);
    expect(heads.length).toBeGreaterThan(10);
    expect(heads.filter((h) => /charPrIDRef="(?!4294967295")/.test(h))).toEqual([]);
    expect(find(await open(HANCOM, out), "개요 7 수준").list?.mk).toBe("① ");
  });

  it("a picture bullet is not kept raw (its binItem is not in the rewrite): its character instead", async () => {
    const bytes = variant((h) => h.replace(/<hh:bullet\b([^>]*?)useImage="0"([^>]*)>/, '<hh:bullet$1useImage="1"$2><hc:img binaryItemIDRef="image9" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>'));
    const doc = await open(HANCOM, bytes);
    redefineLevel(doc, "hwpx-n1", 1, { format: "upperLetter", text: "%2." });
    const { out } = await save(doc, "hwpx");
    const header = part(out, "Contents/header.xml");
    expect(header).not.toContain("image9");
    expect(header).not.toContain('useImage="1"');
  });

  it("개요 10 (no model level) is not drawn as 개요 9", async () => {
    // the 개요 7 heading made 개요 10 (paraPr OUTLINE level 9)
    const files = unzipSync(new Uint8Array(readFileSync(HANCOM)));
    const sec = strFromU8(files["Contents/section0.xml"]);
    const pr = /<hp:p\b[^>]*paraPrIDRef="(\d+)"(?:(?!<hp:p\b)[\s\S])*?개요 7 수준/.exec(sec)![1];
    files["Contents/header.xml"] = strToU8(
      strFromU8(files["Contents/header.xml"]).replace(new RegExp(`(<hh:paraPr id="${pr}"[\\s\\S]*?<hh:heading type="OUTLINE" idRef="\\d+" level=")\\d+"`), (_, a: string) => a + '9"'),
    );
    const doc = await open(HANCOM, zipSync(files));
    const p = find(doc, "개요 7 수준");
    expect(p.list).toBeUndefined();
  });

  it("a plain list in the outline format, deeper than 6 levels, keeps its own numbering (not 개요 7)", async () => {
    installDom();
    const page = newPage("DOCUMENT");
    const t = newText("하나\n일곱", 600, { fontSize: 14 });
    t.paragraphs[0].list = { id: "L1", def: "outline", level: 0 };
    t.paragraphs[1].list = { id: "L1", def: "outline", level: 6 };
    page.nodes.push(t);
    const out = exportHwpx([page], "t");
    const header = part(out, "Contents/header.xml");
    expect(header).not.toMatch(/name="개요 7"/);
    expect(header).not.toMatch(/type="OUTLINE"[^>]*level="6"/);
    expect(header).toMatch(/<hh:heading type="NUMBER" idRef="\d+" level="6"\/>/);
  });

  it("markers past a glyph range: the nearest format, no crash", () => {
    for (const fmt of Object.keys(HWPX_NUMFMT_IN))
      for (const n of [0, -1, 15, 21, 27, 51, 100, 1000]) expect(typeof hwpxFormatNumber(n, fmt)).toBe("string");
    expect(hwpxFormatNumber(15, "CIRCLED_HANGUL_SYLLABLE")).toBe(formatNumber(15, "ganada"));
    expect(hwpxFormatNumber(21, "CIRCLED_DIGIT")).toBe(formatNumber(21, "circled"));
    expect(hwpxFormatNumber(11, "CIRCLED_IDEOGRAPH")).toBe(formatNumber(11, "circled"));
    expect(hwpxFormatNumber(11, "HANGUL_PHONETIC")).toBe("11");
    expect(hwpxFormatNumber(1, "NO_SUCH_FORMAT")).toBe("1");
  });

  it("'1. ' typed after the ① of the 개요 7 heading stays text (surgical save)", async () => {
    const doc = await open(HANCOM);
    const p = find(doc, "개요 7 수준");
    const mk = RT.markerLength(p);
    expect(mk).toBe(2);
    p.runs = p.runs.map((r, i) => (i === 0 ? { ...r, text: r.text.slice(0, mk) + "1. " + r.text.slice(mk) } : r));
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]); // not the full rewrite (it was, once 개요 7 became an outline item)
    const q = find(await open(HANCOM, out), "1. 개요 7 수준");
    expect(q.list?.mk).toBe("① ");
    expect(text(q).startsWith("① 1. 개요 7 수준")).toBe(true);
  });
});

describe("hwpx-outline: DOCX not touched", () => {
  it("DOCX import carries no HWPX level data; a DOCX outline edit still writes Word levels", async () => {
    const doc = await open(DOCX);
    const defs = nodes(doc).flatMap((n) => n.lists ?? []);
    expect(defs.length).toBeGreaterThan(0);
    expect(defs.every((d) => d.levels.every((l) => !l.hwpx) && !d.hwpxMore)).toBe(true);
    redefineLevel(doc, "docx-a2", 1, { text: "%1-%2" });
    const { out } = await save(doc, "docx");
    expect(part(out, "word/numbering.xml")).toContain('<w:lvlText w:val="%1-%2"/>');
    const again = await open(DOCX, out);
    expect(resolveDef(find(again, "주요 성과").list!.def, nodes(again).flatMap((n) => n.lists ?? [])).levels[1].text).toBe("%1-%2");
  });

  it("an HWPX-read definition written to DOCX: Word formats only (the nearest one), no HWPX attributes", async () => {
    const doc = await open(HANCOM);
    const { out } = await save(doc, "docx");
    const num = part(out, "word/numbering.xml");
    expect(num).not.toMatch(/paraHead|CIRCLED_HANGUL|checkable/);
    expect(num).toContain('<w:lvlText w:val="%7"/>');
  });
});
