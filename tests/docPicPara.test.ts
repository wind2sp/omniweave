// doc-pic-para (2026-11-18): paragraph-boundary edits of paragraphs holding pictures saved in place in a DOC opened with
// its formatting, as Word holds them — a picture in the line (the 0x01 picture character, sprmCPicLocation) moves with
// its place in the text, a floating picture's anchor (the 0x08 character, PlcfSpa) follows its paragraph:
//  - the editor (core/flow.ts followParas, in reflowSegment): after Enter or paragraphs joined, each picture's place
//    (ImageNode.place: paragraph and letters before it) is where its text went — Enter right before it or at a
//    paragraph's start: with the letters after it; Enter at a paragraph's end: it stays; joined: into the joined one,
//    after the letters before it; a block drawn right after its paragraph stays right after it;
//  - the writer (io/formats/docWrite.ts textEdits): marks deleted among empty paragraphs are the ones whose paragraphs
//    join as the pages have their pictures; marks deleted around a picture character keep it;
//  - the save's look check (docLooks) compares the pictures in no order (the open lays a floating one out before or
//    after the first frame by its paragraph), a floating one where it is drawn as opened (not its letters before);
//    the shape taken at open (docShape 4) leaves out a picture's letters before it (shape 3 of an older .omw still read).
// Checked in hidden Word (QA_LOG 2026-11-18 doc-pic-para, qa/interop/scripts/doc_pic_check.ps1): every picture in the
// paragraph the pages show, no repair prompt.

import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { exportById, formatForExt } from "../src/io/formats";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docLooks, docProps } from "../src/io/formats/docWrite";
import { docShapeV3, docTextOnly, lastLegacySave, legacySource } from "../src/io/formats/legacyWrite";
import { cfbStreams, readCfbTree } from "../src/io/formats/cfb";
import { collectFlow } from "../src/io/office";
import { followParas, gatherStory, reanchor, reflowSegment, segments } from "../src/core/flow";
import { bodyFormat, deleteChar, insertText, listSeedBefore, markerLength, paraText, splitParagraph } from "../src/core/richtext";
import type { ListCtx } from "../src/core/lists";
import type { ImageNode, OmwDocument, Page, TextParagraph } from "../src/core/types";

const ROOT = process.cwd();
const PICS = join(ROOT, "qa/interop/word-made/omni-legacy-word-pics.doc");
const read = (f: string) => new Uint8Array(readFileSync(f));

async function open(bytes: Uint8Array) {
  const r = await formatForExt("doc")!.open({ name: "omw-picpara.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
/** the body story, edited as the editor applies an edit (docFlow.ts applyParas) */
function editStory(doc: OmwDocument, fn: (ps: TextParagraph[], lc: ListCtx) => TextParagraph[] | null): boolean {
  const seg = segments(doc.pages)[0];
  const st = gatherStory(doc.pages, seg);
  const first = doc.pages[seg.start].nodes.find((n) => n.type === "TEXT" && n.flow);
  const out = fn(st.paras, { defs: st.lists, seed: first ? listSeedBefore(doc.pages, first.id) : undefined });
  if (!out) return false;
  doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
  return true;
}
const enterAt = (ps: TextParagraph[], lc: ListCtx, i: number, o: number) => splitParagraph(ps, { p: i, o }, { body: bodyFormat(ps), lc });
const paras = (pages: readonly Page[]) => collectFlow(pages).flatMap((it) => (it.kind === "p" ? [it.p] : []));
const at = (ps: readonly TextParagraph[], s: string) => ps.findIndex((p) => docParaText(p).includes(s));
const images = (pages: readonly Page[]) => pages.flatMap((pg) => pg.nodes.filter((n): n is ImageNode => n.type === "IMAGE"));
/** each picture: its kind and the text of the paragraph it is in (sorted) */
const picParas = (pages: readonly Page[]) => {
  const text = new Map(paras(pages).map((p) => [p.id, docParaText(p)]));
  return images(pages)
    .map((n) => `${n.place?.mode}|${text.get(n.place?.para ?? "") ?? "?"}`)
    .sort();
};
/** the saved file read again shows the pages and their pictures as they are */
const faithful = (out: Uint8Array, doc: OmwDocument) => {
  const again = docRichOpen(out, "omw-picpara.doc").pages;
  expect(JSON.stringify(docLooks(again, false))).toBe(JSON.stringify(docLooks(doc.pages, false)));
  expect(picParas(again)).toEqual(picParas(doc.pages));
};
const leaks = (file: Uint8Array, s: string) => {
  const forms = [Buffer.from(s, "utf16le"), Buffer.from(s, "latin1")];
  const all = [Buffer.from(file), ...[...cfbStreams(readCfbTree(file)).values()].map((v) => Buffer.from(v))];
  return all.some((b) => forms.some((f) => b.includes(f)));
};
const P = (id: string, text: string, extra: Partial<TextParagraph> = {}): TextParagraph =>
  ({ id, runs: [{ text, fontSize: 12 }], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 6, ...extra }) as TextParagraph;

describe("followParas: a picture's place after Enter or paragraphs joined (shared by every format)", () => {
  it("Enter in the middle: before the caret stays, at it or after it goes with the second part", () => {
    const ps = [P("a", "abcdef"), P("n", "next")];
    const r = splitParagraph(ps, { p: 0, o: 3 }).paras;
    const f = followParas(ps, r)!;
    const q = r[1].id;
    expect(f("a", 2)).toEqual({ para: "a", offset: 2 });
    expect(f("a", 3)).toEqual({ para: q, offset: 0 });
    expect(f("a", 5)).toEqual({ para: q, offset: 2 });
    // (a paragraph left as it was: nothing to follow)
    expect(f("n", 1)).toBeNull();
  });
  it("Enter at a paragraph's start: with its letters; at its end: it stays", () => {
    const ps = [P("a", "ab"), P("n", "next")];
    const s = splitParagraph(ps, { p: 0, o: 0 }).paras;
    expect(followParas(ps, s)!("a", 0)).toEqual({ para: s[1].id, offset: 0 });
    const e = splitParagraph(ps, { p: 0, o: 2 }).paras;
    expect(followParas(ps, e)!("a", 2)).toBeNull();
  });
  it("paragraphs joined: into the joined one after the letters before it — an empty one's too; letters typed before it move it", () => {
    const ps = [P("a", "ab"), P("e", ""), P("c", "cd"), P("z", "z")];
    const j = deleteChar(ps, { p: 0, o: 2 }, 1).paras; // a + e
    expect(followParas(ps, j)!("e", 0)).toEqual({ para: "a", offset: 2 });
    const k = deleteChar(deleteChar(ps, { p: 0, o: 2 }, 1).paras, { p: 0, o: 2 }, 1).paras; // a + e + c
    const fk = followParas(ps, k)!;
    expect(fk("c", 1)).toEqual({ para: "a", offset: 3 });
    expect(fk("a", 2)).toEqual({ para: "a", offset: 2 });
    const t = insertText(ps, { p: 2, o: 0 }, "xy").paras;
    expect(followParas(ps, t)!("c", 0)).toEqual({ para: "c", offset: 2 });
  });
  it("a list's number, note marks and objects in the line are not letters it counts; two edits apart each followed", () => {
    const li = P("l", "• abc", { role: "li" });
    const noted = { ...P("n", ""), runs: [{ text: "ab", fontSize: 12 }, { text: "1", fontSize: 12, note: { kind: "foot", paras: [] } }, { text: "cd", fontSize: 12 }] } as TextParagraph;
    expect(markerLength(li)).toBe(2);
    const ps = [li, noted, P("m", "mid"), P("m2", "mid2"), P("z", "zz")];
    // Enter in the noted paragraph after "ab1"; Enter in the list item after "a" (the new item: "• bc")
    let r = splitParagraph(ps, { p: 1, o: 3 }).paras;
    r = splitParagraph(r, { p: 0, o: 3 }).paras;
    expect(paraText(r[1])).toBe("• bc");
    const f = followParas(ps, r)!;
    expect(f("l", 1)).toEqual({ para: r[1].id, offset: 0 }); // (the new item's marker not counted)
    expect(f("l", 0)).toEqual({ para: "l", offset: 0 });
    expect(f("n", 3)).toEqual({ para: r[3].id, offset: 1 }); // (letters "ab" "cd": after "c", in the second part)
    expect(f("n", 2)).toEqual({ para: "n", offset: 2 });
  });
});

describe.runIf(existsSync(PICS))("DOC paragraphs with pictures: boundary edits saved in place", () => {
  it("the file: three pictures in the line (in the middle, at the end, at the start of a paragraph) and two floating ones; unedited, the original bytes", async () => {
    const bytes = read(PICS);
    const doc = await open(bytes);
    const imgs = images(doc.pages);
    expect(imgs.filter((n) => n.place?.mode === "inline").length).toBe(3);
    expect(imgs.filter((n) => n.place?.mode === "float").length).toBe(2);
    expect(picParas(doc.pages)).toEqual(["float|", "float|떠 있는 그림의 기준 문단입니다.", "inline| 앞에 그림이 있는 문단.", "inline|가운데 앞 글  가운데 뒤 글.", "inline|끝에 그림이 있는 문단 "]);
    expect(Buffer.from(await save(doc)).equals(Buffer.from(bytes))).toBe(true);
  });

  const cases: [string, (ps: TextParagraph[], lc: ListCtx) => TextParagraph[], string, string[]][] = [
    // [what, edit, the saved main text has this, the pictures' paragraphs]
    ["Enter right before the picture in the middle: it begins the second part", (ps, lc) => enterAt(ps, lc, at(ps, "가운데 앞"), 8).paras, "가운데 앞 글 \r\x01 가운데 뒤 글.\r", ["inline| 가운데 뒤 글."]],
    ["Enter after the letter after it: it ends the first part", (ps, lc) => enterAt(ps, lc, at(ps, "가운데 앞"), 9).paras, "가운데 앞 글 \x01 \r가운데 뒤 글.\r", ["inline|가운데 앞 글  "]],
    ["Enter at the end of the paragraph whose picture ends it (and typing): it stays", (ps, lc) => {
      const i = at(ps, "끝에 그림");
      const r = enterAt(ps, lc, i, paraText(ps[i]).length);
      return insertText(r.paras, r.pos, "omw 새 글").paras;
    }, "끝에 그림이 있는 문단 \x01\romw 새 글\r", ["inline|끝에 그림이 있는 문단 "]],
    ["Enter at the start of the paragraph a picture begins: the new empty one before it", (ps, lc) => enterAt(ps, lc, at(ps, "앞에 그림"), 0).paras, "\r\r\x01 앞에 그림이 있는 문단.\r", ["inline| 앞에 그림이 있는 문단."]],
    ["the paragraph with the picture at its start joined to the one before (Backspace)", (ps) => deleteChar(ps, { p: at(ps, "앞에 그림"), o: 0 }, -1).paras, "있는 문단 \x01\x01 앞에 그림이", ["inline|끝에 그림이 있는 문단  앞에 그림이 있는 문단."]],
    ["the paragraph with the floating picture's anchor joined to the one before: the anchor follows into it", (ps) => deleteChar(ps, { p: at(ps, "떠 있는"), o: 0 }, -1).paras, "보통 문단 하나.\b떠 있는", ["float|보통 문단 하나.떠 있는 그림의 기준 문단입니다."]],
    ["the empty paragraph holding a floating picture joined between two (Delete twice): both anchors in the joined one", (ps) => {
      const i = at(ps, "떠 있는");
      const r = deleteChar(ps, { p: i, o: paraText(ps[i]).length }, 1).paras;
      return deleteChar(r, { p: i, o: paraText(r[i]).length }, 1).paras;
    }, "\b떠 있는 그림의 기준 문단입니다.\b그 뒤 문단 하나.\r", ["float|떠 있는 그림의 기준 문단입니다.그 뒤 문단 하나."]],
  ];
  it.each(cases)("%s", async (_what, edit, text, want) => {
    const doc = await open(read(PICS));
    const was = images(doc.pages).filter((n) => n.place?.mode === "float").map((n) => [n.transform.x, n.transform.y]);
    expect(editStory(doc, (ps, lc) => edit(ps, lc))).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.doc).toBe("text");
    faithful(out, doc);
    expect(docProps(out).text).toContain(text);
    for (const w of want) expect(picParas(doc.pages)).toContain(w);
    // (a floating picture stays where it is drawn: its anchor only follows the text)
    expect(images(doc.pages).filter((n) => n.place?.mode === "float").map((n) => [n.transform.x, n.transform.y])).toEqual(was);
  });

  it("the block of a picture in the line stays drawn right after its paragraph (Enter at its end: before the new one)", async () => {
    const doc = await open(read(PICS));
    editStory(doc, (ps, lc) => enterAt(ps, lc, at(ps, "끝에 그림"), paraText(ps[at(ps, "끝에 그림")]).length).paras);
    const st = gatherStory(doc.pages, segments(doc.pages)[0]);
    const i = at(st.paras, "끝에 그림");
    const pic = st.objs.find((o) => o.node.type === "IMAGE" && o.node.place?.para === st.paras[i].id)!;
    expect(pic.before).toBe(st.paras[i + 1].id);
  });

  it("every boundary edit of every paragraph saves in place and reads back as the pages show it", async () => {
    const bytes = read(PICS);
    const base = await open(bytes);
    const n0 = gatherStory(base.pages, segments(base.pages)[0]).paras.length;
    const kinds = ["merge", "back", "start", "mid", "end", "endType", "mergeMerge"];
    let tried = 0;
    for (let i = 0; i < n0; i++)
      for (const kind of kinds) {
        const doc = await open(bytes);
        const ok = editStory(doc, (ps, lc) => {
          const len = paraText(ps[i]).length;
          if (kind === "merge") return ps[i + 1] ? deleteChar(ps, { p: i, o: len }, 1).paras : null;
          if (kind === "back") return i > 0 ? deleteChar(ps, { p: i, o: 0 }, -1).paras : null;
          if (kind === "start") return enterAt(ps, lc, i, 0).paras;
          if (kind === "mid") return len < 2 ? null : enterAt(ps, lc, i, Math.floor(len / 2)).paras;
          if (kind === "end") return enterAt(ps, lc, i, len).paras;
          if (kind === "endType") {
            const r = enterAt(ps, lc, i, len);
            return insertText(r.paras, r.pos, "omw 새 글").paras;
          }
          if (!ps[i + 2]) return null;
          const r = deleteChar(ps, { p: i, o: len }, 1).paras;
          return deleteChar(r, { p: i, o: paraText(r[i]).length }, 1).paras;
        });
        if (!ok) continue;
        tried++;
        const out = await save(doc);
        faithful(out, doc);
      }
    expect(tried).toBeGreaterThan(50);
  }, 120000);

  it("10 saves one after another (a picture's paragraph split with a secret typed, joined, the secret deleted): the size bounded, the secret gone", async () => {
    let bytes = read(PICS);
    const sizes: number[] = [];
    let secret = "";
    for (let k = 0; k < 10; k++) {
      const doc = await open(bytes);
      const step = k % 3;
      if (step === 0) {
        secret = `omwpicsecret${k}x`;
        editStory(doc, (ps, lc) => {
          const r = enterAt(ps, lc, at(ps, "가운데 앞"), 8);
          return insertText(r.paras, r.pos, secret).paras;
        });
      } else if (step === 1) editStory(doc, (ps) => deleteChar(ps, { p: at(ps, secret), o: 0 }, -1).paras);
      else
        editStory(doc, (ps) => {
          const i = at(ps, secret);
          const o = docParaText(ps[i]).indexOf(secret) + markerLength(ps[i]);
          let r = ps;
          for (let c = 0; c < secret.length; c++) r = deleteChar(r, { p: i, o: o + secret.length - c }, -1).paras;
          return r;
        });
      const out = await save(doc);
      expect(lastLegacySave.doc, `edit ${k}`).toBe("text");
      faithful(out, doc);
      expect(leaks(out, secret), `edit ${k}`).toBe(step !== 2);
      sizes.push(out.length);
      bytes = out;
    }
    for (const s of sizes) expect(s).toBeLessThanOrEqual(sizes[0] + 2048);
  }, 120000);

  it("a document opened before (its shape taken as shape 3): a text edit still saves in place; a picture moved by an edit, never lossy", async () => {
    const doc = await open(read(PICS));
    legacySource(doc.pages, "doc")!.legacy!.shape = docShapeV3(doc.pages);
    editStory(doc, (ps) => insertText(ps, { p: at(ps, "보통 문단"), o: 2 }, "omw").paras);
    expect(docTextOnly(doc.pages)).toBe(true);
    faithful(await save(doc), doc);
    const doc2 = await open(read(PICS));
    legacySource(doc2.pages, "doc")!.legacy!.shape = docShapeV3(doc2.pages);
    editStory(doc2, (ps) => deleteChar(ps, { p: at(ps, "떠 있는"), o: 0 }, -1).paras);
    let out: Uint8Array | null = null;
    try {
      out = await save(doc2);
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/DOCX/i);
    }
    if (out) faithful(out, doc2);
  });

  it("other formats: the DOCX of the pages after Enter at the end of the paragraph a picture ends has the picture right after that paragraph", async () => {
    const doc = await open(read(PICS));
    editStory(doc, (ps, lc) => {
      const i = at(ps, "끝에 그림");
      const r = enterAt(ps, lc, i, paraText(ps[i]).length);
      return insertText(r.paras, r.pos, "omw 새 글").paras;
    });
    const docx = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    const xml = strFromU8(unzipSync(docx)["word/document.xml"]);
    const a = xml.indexOf("끝에 그림이 있는 문단"), b = xml.indexOf("omw 새 글");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(xml.slice(a, b)).toContain("<w:drawing>");
  });
});
