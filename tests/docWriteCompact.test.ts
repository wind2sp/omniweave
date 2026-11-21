// DOC same-format save, repeated (io/formats/docWrite.ts writeEdits compact, tailOf, sameWritten — doc-compact): a file
// saved by us and edited and saved again does not grow with each save — the text and formatting pages an earlier save
// appended are written again from where they began, the Clx and Btes an earlier save appended at the table stream's end
// in their place. Each cycle: open the last saved file, edit, save, read back. The text is the one edited after every
// cycle, text deleted in a cycle is in no stream of the file after it, the size stays near the size after one save, and
// an unedited save is the file itself. (QA) A file whose end is not as our saves leave it — Word's own fast save
// (fComplex), bytes our saves do not put there — and every first save of a Word file: appended, as before.
// Files: qa/interop/word-made/omni-legacy-word-*.doc. OMW_COMPACT_LOG=1 prints the sizes.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
// (the DOC open reads its formatting through the DOCX importer, which parses XML: docRich.ts)
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfbStreams, readCfbTree, writeCfb } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { lastLegacySave } from "../src/io/formats/legacyWrite";
import { docProps } from "../src/io/formats/docWrite";
import { deleteRange, insertText } from "../src/core/richtext";
import type { OmwDocument, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

const DIR = join(process.cwd(), "qa/interop/word-made");
const files = existsSync(DIR) ? readdirSync(DIR).filter((f) => /^omni-legacy-word-.*\.doc$/i.test(f)) : [];
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("doc")!.open({ name: "omw-compact.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const flowTexts = (doc: OmwDocument) => collectFlow(doc.pages).map((it) => (it.kind === "p" ? plain(it.p) : it.t.rows.map((r) => r.map((c) => c.text))));
/** body paragraphs (whole ones) with the frame holding each */
const bodyParas = (doc: OmwDocument) =>
  doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs.flatMap((p, i) => (p.flowSplit || p.flowCont ? [] : [{ n, i, text: plain(p) }]))));
/** paragraphs to type in: body text with letters (the first and the last such — not a heading or a list item: their
 *  Enter and first letters follow the editor's own rules, which the file's styles do not, so such an edit is refused;
 *  the first may be a heading: letters are only typed into it) */
const targets = (doc: OmwDocument) => {
  const all = bodyParas(doc).filter((b) => /[A-Za-z가-힣]{2}/.test(b.text) && !b.n.paragraphs[b.i].list);
  const plainText = all.filter((b) => !b.n.paragraphs[b.i].role);
  return [all[0], plainText[plainText.length - 1]];
};
const wordDoc = (file: Uint8Array) => cfbStreams(readCfbTree(file)).get("WordDocument")!;
/** whether a text is in any stream of the file, or anywhere in its bytes (UTF-16LE, and as 8-bit text) */
const leaks = (file: Uint8Array, s: string) => {
  const forms = [Buffer.from(s, "utf16le"), Buffer.from(s, "latin1")];
  const all = [Buffer.from(file), ...[...cfbStreams(readCfbTree(file)).values()].map((v) => Buffer.from(v))];
  return all.some((b) => forms.some((f) => b.includes(f)));
};

describe.each(files.map((f) => [f]))("repeated saves stay bounded: %s", (name) => {
  const orig = new Uint8Array(readFileSync(join(DIR, name)));

  it("an unedited save is the file itself (also after saves of ours)", async () => {
    expect(eq(await save(await open(orig)), orig)).toBe(true);
    const doc = await open(orig);
    const [a] = targets(doc);
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: a.text.length }, " omwonce").paras;
    const once = await save(doc);
    expect(lastLegacySave.doc).toBe("text");
    expect(eq(await save(await open(once)), once)).toBe(true);
  });

  it("10 edit → save → reopen cycles: the text as edited, deleted text gone, the size near one save's", async () => {
    let bytes = orig;
    const sizes: number[] = [], wds: number[] = [], tbl: number[] = [];
    let secret = "";
    for (let i = 0; i < 10; i++) {
      const doc = await open(bytes);
      const [a, b] = targets(doc);
      if (i % 2 === 0) {
        // type a secret word at the end of the first paragraph, and a word that stays in the last
        secret = `omwsecret${i}x`;
        a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: a.text.length }, ` ${secret}`).paras;
        const c = targets(doc)[1];
        // (a new paragraph too, every other time: Enter typed — its mark's PAPX written again in later saves)
        c.n.paragraphs = insertText(c.n.paragraphs, { p: c.i, o: 0 }, i % 4 === 0 ? `omwpara${i}\nomwkeep${i} ` : `omwkeep${i} `).paras;
      } else {
        // delete the secret again, and type in the middle of the first paragraph
        const at = a.text.indexOf(` ${secret}`);
        expect(at).toBeGreaterThanOrEqual(0);
        a.n.paragraphs = deleteRange(a.n.paragraphs, { start: { p: a.i, o: at }, end: { p: a.i, o: at + secret.length + 1 } }).paras;
        void b;
        const c = targets(doc)[0];
        c.n.paragraphs = insertText(c.n.paragraphs, { p: c.i, o: Math.floor(c.text.length / 2) }, `·${i}·`).paras;
      }
      const want = flowTexts(doc);
      const out = await save(doc);
      expect(lastLegacySave.doc, `cycle ${i}`).toBe("text");
      const back = await open(out);
      expect(flowTexts(back), `cycle ${i}`).toEqual(want);
      if (i % 2 === 1) expect(leaks(out, secret), `cycle ${i}: ${secret}`).toBe(false);
      else expect(leaks(out, secret)).toBe(true);
      sizes.push(out.length);
      wds.push(wordDoc(out).length);
      { const st = cfbStreams(readCfbTree(out)); tbl.push(st.get("1Table")?.length ?? st.get("0Table")!.length); }
      bytes = out;
    }
    if (process.env.OMW_COMPACT_LOG) console.log(name, orig.length, sizes.join(" "), "WordDocument", wordDoc(orig).length, wds.join(" "), "table", tbl.join(" "));
    // (each save adds a few letters and pieces: the file within 2 KB of its size after one save, WordDocument within 1 KB)
    for (const s of sizes) expect(s).toBeLessThanOrEqual(sizes[0] + 2048);
    for (const s of wds) expect(s).toBeLessThanOrEqual(wds[0] + 1024);
    // and the text of every cycle that stays: still there
    const last = JSON.stringify(flowTexts(await open(bytes)));
    for (let i = 0; i < 10; i += 2) expect(last).toContain(`omwkeep${i} `);
    for (let i = 0; i < 10; i += 4) expect(last).toContain(`"omwpara${i}"`);
    // the paragraphs typed with Enter, written again by later saves: as Word finds them, they end at their own mark and
    // have the look of the paragraph they were cut from; their letters the look of the letters after them
    const props = docProps(bytes);
    for (let i = 0; i < 10; i += 4) {
      const cp = props.text.indexOf(`omwpara${i}\r`);
      expect(cp).toBeGreaterThan(0);
      const mine = props.para(cp), next = props.para(cp + 9 + i.toString().length);
      expect(mine?.mark).toBe(cp + 7 + i.toString().length);
      expect(Array.from(mine?.papx ?? [])).toEqual(Array.from(next?.papx ?? []));
    }
    for (let i = 1; i < 10; i += 2) expect(last).toContain(`·${i}·`);
  });

  it("text an earlier save appended, deleted in a later one: in no stream", async () => {
    const doc = await open(orig);
    const [a] = targets(doc);
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: a.text.length }, " omwgoneA omwstayB").paras;
    const one = await save(doc);
    const d2 = await open(one);
    const [a2] = targets(d2);
    const at = a2.text.indexOf(" omwgoneA");
    a2.n.paragraphs = deleteRange(a2.n.paragraphs, { start: { p: a2.i, o: at }, end: { p: a2.i, o: at + 9 } }).paras;
    const two = await save(d2);
    expect(lastLegacySave.doc).toBe("text");
    expect(leaks(two, "omwgoneA")).toBe(false);
    expect(leaks(two, "omwstayB")).toBe(true);
    expect(flowTexts(await open(two))).toEqual(flowTexts(d2));
    // (written again from where the first save's text began: not longer than the first save)
    expect(wordDoc(two).length).toBeLessThanOrEqual(wordDoc(one).length);
  });

  it("(QA) a file whose end is not as our saves leave it — fComplex (Word's fast save), a byte our saves never write: appended", async () => {
    const doc = await open(orig);
    const [a] = targets(doc);
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: a.text.length }, " omwfirst").paras;
    const once = await save(doc);
    const wd1 = wordDoc(once);
    // (where the first save's text ends, its spare character too: the CHPX Bte's last FC — zeros after it up to the pages)
    const tb = cfbStreams(readCfbTree(once)).get(wd1[0x0b] & 0x02 ? "1Table" : "0Table")!;
    const fc = u32(wd1, 154 + 12 * 8), lcb = u32(wd1, 154 + 12 * 8 + 4);
    const end = u32(tb, fc + ((lcb - 4) / 8) * 4);
    expect(end % 512).not.toBe(0);
    const from = wordDoc(orig).length;
    const variants: [string, (wd: Uint8Array) => void][] = [
      ["fComplex", (wd) => void (wd[0x0a] |= 0x04)],
      ["a byte after the text", (wd) => void (wd[end] = 0x41)],
    ];
    for (const [what, change] of variants) {
      const tree = readCfbTree(once);
      const node = tree.root.kids!.find((k) => k.name === "WordDocument")!;
      node.data = node.data!.slice();
      change(node.data);
      const bytes = writeCfb(tree);
      const d = await open(bytes);
      const [b] = targets(d);
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: b.text.length }, " omwsecond").paras;
      const out = await save(d);
      expect(lastLegacySave.doc, what).toBe("text");
      expect(flowTexts(await open(out)), what).toEqual(flowTexts(d));
      // (appended: the bytes the first save put after the original's stay as they were, the file grows)
      const w0 = wordDoc(bytes), w = wordDoc(out);
      expect(w.length, what).toBeGreaterThan(w0.length);
      expect(eq(w.subarray(from, w0.length), w0.subarray(from)), what).toBe(true);
    }
  });
});

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
