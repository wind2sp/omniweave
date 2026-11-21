// HWP 5.0 same-format save, stage 2 (io/formats/hwp5Write.ts hwp5Edit / writeHwp5Text, io/formats/hwp5Body.ts): a text
// edit is written into the BodyText records — the edited paragraphs' records made again, every other paragraph and
// every other stream byte for byte — and read back with our reader; any other edit is refused (save as HWPX).
// Files: the HWP files 한글 made in qa/interop (hancom-made, adobe-made); OMW_HWP5_FILES=<a.hwp>;<b.hwp>… adds local
// files (not in the repo, reported as "local #n").

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { inflateSync } from "fflate";
import { readCfb } from "../src/io/formats/cfb";
import { hwp5Edit, hwp5Fingerprint, hwp5Source } from "../src/io/formats/hwp5Write";
import { parseRecords, previewText, type HRec } from "../src/io/formats/hwp5Body";
import { exportById, formatForExt } from "../src/io/formats";
import { DEFAULT_RUN, type OmwDocument, type Page, type TableNode, type TextNode, type TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const repoFiles = ["qa/interop/hancom-made", "qa/interop/adobe-made"].flatMap((d) =>
  existsSync(join(ROOT, d))
    ? readdirSync(join(ROOT, d))
        .filter((f) => /\.hwp$/i.test(f))
        .map((f) => join(ROOT, d, f))
    : [],
);
const extra = (process.env.OMW_HWP5_FILES ?? "").split(";").filter((f) => f && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

const open = (file: string) => open2(new Uint8Array(readFileSync(file)));
async function open2(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("hwp")!.open({ name: "omw-edit.hwp", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("hwp")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
/** body paragraphs (TEXT nodes) in flow order with the node holding each */
const paras = (doc: OmwDocument) => doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs.map((p) => ({ n, p }))));
/** texts our reader finds in the file: every paragraph of the flow, table cells too */
async function texts(hwp: Uint8Array): Promise<string[]> {
  const r = await formatForExt("hwp")!.open({ name: "omw-back.hwp", path: null, bytes: hwp }, {} as any);
  return collectFlow(r.pages).flatMap((it) => (it.kind === "p" ? [plain(it.p)] : it.t.rows.flat().map((c) => c.text)));
}
const sectionRecs = (hwp: Uint8Array) => {
  const c = readCfb(hwp);
  return [...c.streams.keys()]
    .filter((k) => /^BodyText\/Section\d+$/.test(k))
    .sort()
    .map((k) => ({ k, recs: parseRecords(inflateSync(c.get(k)!)) }));
};
/** a record tree's bytes as stored (header + data of each record), bit 31 of a paragraph's count cleared */
const treeBytes = (r: HRec): string => {
  const d = r.tag === 0x42 ? Uint8Array.from(r.data, (v, i) => (i === 3 ? v & 0x7f : v)) : r.data;
  return `${r.tag}.${r.level}:${Buffer.from(d).toString("hex")}[${r.kids.map(treeBytes).join(",")}]`;
};
/** streams other than the BodyText sections and the previews byte for byte the same; the preview picture not the original (stage 3) */
function otherStreamsSame(a: Uint8Array, b: Uint8Array) {
  const x = readCfb(a).streams, y = readCfb(b).streams;
  expect([...y.keys()].sort()).toEqual([...x.keys()].sort());
  for (const [k, v] of x) if (!/^BodyText\/Section\d+$/.test(k) && k !== "PrvText" && k !== "PrvImage") expect(eq(y.get(k)!, v), k).toBe(true);
  if (x.get("PrvImage")) expect(eq(y.get("PrvImage")!, x.get("PrvImage")!), "PrvImage").toBe(false);
}
/** paragraphs of the original sections kept byte for byte in the saved one, in order; the count of the others */
function keptParas(a: Uint8Array, b: Uint8Array): { kept: number; total: number } {
  let kept = 0, total = 0;
  const sa = sectionRecs(a), sb = sectionRecs(b);
  sa.forEach((s, i) => {
    const bs = new Set(sb[i].recs.map(treeBytes));
    total += s.recs.length;
    kept += s.recs.filter((r) => bs.has(treeBytes(r))).length;
  });
  return { kept, total };
}

const MARK = " 오메고침omw";

describe.each(files.map((f) => [label(f), f]))("text edit saved as HWP: %s", (_name, file) => {
  const orig = new Uint8Array(readFileSync(file));

  it("keeps the fingerprint of an unedited document", async () => {
    const doc = await open(file);
    const src = hwp5Source(doc.pages)!;
    expect(src.hwp5!.fp).toBe(hwp5Fingerprint(doc.pages).fp);
    expect(hwp5Edit(doc.pages, src, doc.assets).kind).toBe("none");
    expect(eq(await save(doc), orig)).toBe(true);
  });

  it("writes an edited paragraph's text into its records, the rest byte for byte", async () => {
    const doc = await open(file);
    // (a document whose text is all in tables has only empty paragraphs: the first gets text)
    const target = paras(doc).find((x) => plain(x.p).trim()) ?? paras(doc)[0];
    if (!target) return;
    const before = plain(target.p);
    const run = [...target.p.runs].reverse().find((r) => r.text) ?? target.p.runs[0];
    if (!run) target.p.runs.push({ ...DEFAULT_RUN, text: MARK });
    else run.text += MARK;
    expect(hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets).kind).toBe("text");
    const out = await save(doc);
    otherStreamsSame(orig, out);
    const k = keptParas(orig, out);
    expect(k.kept).toBe(k.total - 1); // only the edited top-level paragraph is new
    const back = await texts(out);
    expect(back).toContain(before + MARK);
    // the preview text shows the edit
    if (readCfb(out).get("PrvText")) {
      const prv = Buffer.from(readCfb(out).get("PrvText")!).toString("utf16le");
      if (prv.length < 1000) expect(prv).toContain(MARK.trim());
    }
    // the file we wrote opens, and saved again unedited is the same bytes (its own fingerprint holds)
    const back2 = await open2(out);
    expect(eq(await save(back2), out)).toBe(true);
  });

  it("adds and deletes paragraphs", async () => {
    const doc = await open(file);
    const whole = paras(doc).filter((x) => !x.p.flowCont && !x.p.flowSplit);
    const list = whole.some((x) => plain(x.p).trim()) ? whole.filter((x) => plain(x.p).trim()) : whole;
    const a = list[1] ?? list[0];
    if (!a) return;
    const gone = list[list.length - 1] !== a ? list[list.length - 1] : undefined;
    const added: TextParagraph = { ...a.p, id: "omw-new-para", runs: [{ ...(a.p.runs.find((r) => r.text) ?? DEFAULT_RUN), text: "새 문단 omw" }], hwpLines: undefined };
    a.n.paragraphs.splice(a.n.paragraphs.indexOf(a.p) + 1, 0, added);
    const goneText = gone ? plain(gone.p) : null;
    if (gone) gone.n.paragraphs.splice(gone.n.paragraphs.indexOf(gone.p), 1);
    const e = hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    otherStreamsSame(orig, out);
    const back = await texts(out);
    const at = back.indexOf(plain(a.p));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(back[at + 1]).toBe("새 문단 omw");
    if (goneText) expect(back.filter((x) => x === goneText).length).toBe((await texts(orig)).filter((x) => x === goneText).length - 1);
    // the last paragraph of each list carries bit 31, no other
    for (const s of sectionRecs(out)) {
      const walk = (list: HRec[]) => {
        const ps = list.filter((r) => r.tag === 0x42);
        ps.forEach((p, i) => expect(p.data[3] >= 0x80, `${s.k} ${i}/${ps.length}`).toBe(i === ps.length - 1));
      };
      walk(s.recs);
    }
  });

  it("writes a table cell's new text", async () => {
    const doc = await open(file);
    // (the surgeon rewrites the cells of a table without merged cells; a merged one is written anew as HWPX)
    const table = doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE" && n.rows.flat().some((c) => c.text.trim()) && n.rows.flat().every((c) => (c.colSpan ?? 1) === 1 && (c.rowSpan ?? 1) === 1));
    if (!table) return;
    const cell = table.rows.flat().find((c) => c.text.trim() && !c.text.includes("\n"))!;
    const was = cell.text;
    cell.text = was + MARK;
    if (cell.richText) cell.richText = cell.richText.map((p, i, all) => (i === all.length - 1 ? { ...p, runs: [...p.runs.slice(0, -1), ...p.runs.slice(-1).map((r) => ({ ...r, text: r.text + MARK }))] } : p));
    const e = hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets);
    expect(e.kind, e.kind === "other" ? e.why : "").toBe("text");
    const out = await save(doc);
    otherStreamsSame(orig, out);
    expect(await texts(out)).toContain(was + MARK);
    const k = keptParas(orig, out);
    expect(k.kept).toBe(k.total - 1); // the paragraph holding the table
  });

  it("refuses a format change, a new shape and a memo (save as HWPX)", async () => {
    const doc = await open(file);
    const target = paras(doc).find((x) => plain(x.p).trim());
    if (!target) return;
    target.p.align = target.p.align === "CENTER" ? "RIGHT" : "CENTER";
    expect(hwp5Edit(doc.pages, hwp5Source(doc.pages)!, doc.assets).kind).toBe("other");
    await expect(save(doc)).rejects.toThrow();

    const d2 = await open(file);
    const r2 = paras(d2).find((x) => plain(x.p).trim())!.p.runs.find((r) => r.text)!;
    r2.fontSize = r2.fontSize * 1.7 + 3; // a size no shape of the file has
    expect(hwp5Edit(d2.pages, hwp5Source(d2.pages)!, d2.assets).kind).toBe("other");

    const d3 = await open(file);
    const r3 = paras(d3).find((x) => plain(x.p).trim())!.p.runs.find((r) => r.text)!;
    r3.comments = ["omw-memo"];
    d3.pages[0].comments = [{ id: "omw-memo", author: "Omniweave QA", paras: [] } as any];
    expect(hwp5Edit(d3.pages, hwp5Source(d3.pages)!, d3.assets).kind).toBe("other");

    const d4 = await open(file);
    const r4 = paras(d4).find((x) => plain(x.p).trim())!.p.runs.find((r) => r.text)!;
    r4.rev = { kind: "ins", author: "Omniweave QA" };
    expect(hwp5Edit(d4.pages, hwp5Source(d4.pages)!, d4.assets).kind).toBe("other");
  });
});

describe("PrvText", () => {
  it("is made as 한글 writes it", () => {
    // (QA doc-summary) every PrvText 한글 wrote in the repo's files: ours is the same text, unit for unit — tabs as
    // spaces, a table's last row ended by its paragraph's CR LF, the 1023-unit limit cut one short inside a paragraph
    let n = 0;
    for (const f of repoFiles) {
      const c = readCfb(new Uint8Array(readFileSync(f)));
      const prv = c.get("PrvText");
      if (!prv) continue;
      const secs = [...c.streams.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort().map((k) => inflateSync(c.get(k)!));
      expect(previewText(secs), label(f)).toBe(Buffer.from(prv).toString("utf16le"));
      n++;
    }
    expect(n).toBeGreaterThanOrEqual(8);
  });
});

describe.skipIf(!repoFiles.length)("fingerprint", () => {
  it("does not take a page that moved for an edit", async () => {
    const doc = await open(repoFiles[0]);
    const fp = hwp5Fingerprint(doc.pages);
    for (const p of doc.pages as Page[]) for (const n of p.nodes) n.transform = { ...n.transform, y: n.transform.y + 3 };
    expect(hwp5Fingerprint(doc.pages)).toEqual(fp);
  });
});
