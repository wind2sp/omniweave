// DOC / XLS / PPT same-format save, stage 1 (io/formats/legacyWrite.ts): opening keeps the original file, an unedited
// document saves as that file byte for byte, and every edit is refused (the advice: save as DOCX / XLSX / PPTX). The
// shared compound-file writer (cfb.ts) keeps every stream of these files too (stage 2 will write edits through it).
// Files: every DOC / XLS / PPT in qa/interop. OMW_LEGACY_FILES=<a.doc>;<b.xls>… adds local files (not in the repo).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
// (the DOC open reads its formatting through the DOCX importer, which parses XML: docRich.ts)
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { cfbStreams, readCfb, readCfbTree, writeCfb, type CfbNode } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { LEGACY_KINDS, legacyFingerprint, legacyKeepable, legacySource, legacyUnchanged, without, type LegacyKind } from "../src/io/formats/legacyWrite";
import { newImage, newVector, type OmwDocument, type Page } from "../src/core/types";
import { makeAsset } from "../src/core/assets";
import { packOmw, unpackOmw } from "../src/io/omw";
import { encodePng } from "../src/io/formats/png";
import { DICTS } from "../src/i18n";

const ROOT = process.cwd();
const LEGACY_EXT = /\.(doc|xls|ppt|pps)$/i;
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : LEGACY_EXT.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const extra = (process.env.OMW_LEGACY_FILES ?? "").split(";").filter((f) => f && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const kindOf = (f: string): LegacyKind => {
  const e = f.split(".").pop()!.toLowerCase();
  return e === "pps" ? "ppt" : (e as LegacyKind);
};
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const shape = (n: CfbNode): unknown => ({ name: n.name, kind: n.kind, clsid: [...n.clsid], state: n.stateBits, c: [...n.created], m: [...n.modified], size: n.data?.length, kids: n.kids?.map(shape) });

async function open(file: string | Uint8Array, kind: LegacyKind, ctx: object = {}) {
  const bytes = typeof file === "string" ? new Uint8Array(readFileSync(file)) : file;
  const r = await formatForExt(kind)!.open({ name: `omw-legacy.${kind}`, path: null, bytes }, ctx as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { bytes, doc, r };
}
const save = (doc: OmwDocument, kind: LegacyKind) => exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any) as Promise<Uint8Array>;
const repoFile = (kind: LegacyKind) => repoFiles.find((f) => kindOf(f) === kind)!;

describe("legacy files are there", () => {
  it("has a repo DOC, XLS and PPT", () => {
    for (const k of LEGACY_KINDS) expect(repoFiles.some((f) => kindOf(f) === k), k).toBe(true);
  });
});

describe.each(files.map((f) => [label(f), f]))("unedited save: %s", (_name, file) => {
  const kind = kindOf(file);

  it("keeps the original and saves it back byte for byte", async () => {
    const { bytes, doc } = await open(file, kind);
    const src = legacySource(doc.pages, kind);
    expect(src?.legacy?.kind).toBe(kind);
    expect(doc.assets[src!.legacy!.assetId]?.hash).toBe(src!.legacy!.hash);
    expect(exportById(kind)!.fileName!(doc, doc.pages[0])).toBe("omw-legacy");
    expect(eq(await save(doc, kind), bytes)).toBe(true);
    // the other legacy saves are not offered for it
    for (const k of LEGACY_KINDS) if (k !== kind) expect(legacySource(doc.pages, k)).toBeUndefined();
  });

  it("keeps the original through an .omw save and reopen", async () => {
    const { bytes, doc } = await open(file, kind);
    const packed = packOmw(doc).bytes;
    const src = legacySource(doc.pages, kind)!;
    const stored = Object.entries(unzipSync(packed)).find(([k]) => k.startsWith(`assets/${src.legacy!.hash}.`));
    expect(stored && eq(stored[1], bytes)).toBe(true);
    const back = unpackOmw(packed).doc;
    expect(legacySource(back.pages, kind)?.legacy).toEqual(src.legacy);
    expect(legacyUnchanged(back.pages, kind)).toBe(true);
    expect(eq(await save(back, kind), bytes)).toBe(true);
  });

  it("the shared CFB writer keeps every stream and directory entry", () => {
    const orig = new Uint8Array(readFileSync(file));
    const tree = readCfbTree(orig);
    const again = writeCfb(tree);
    const a = cfbStreams(tree), b = cfbStreams(readCfbTree(again));
    expect([...b.keys()]).toEqual([...a.keys()]);
    for (const [k, v] of a) expect(eq(b.get(k)!, v), k).toBe(true);
    expect(shape(readCfbTree(again).root)).toEqual(shape(tree.root));
  });
});

// Every edit is refused (stage 1): text, formats, pictures, page setup, sheet cells, slide order … — but XLS cell values
// and DOC body text (stage 2)
describe("edits are refused", () => {
  const refused = async (kind: LegacyKind, edit: (doc: OmwDocument) => void) => {
    const { bytes, doc } = await open(repoFile(kind), kind);
    expect(eq(await save(doc, kind), bytes)).toBe(true); // unedited: the original
    edit(doc);
    expect(legacyUnchanged(doc.pages, kind)).toBe(false);
    await expect(save(doc, kind)).rejects.toThrow();
  };
  const texts = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n) => n.type === "TEXT") as any[];
  const firstRun = (doc: OmwDocument) => texts(doc).flatMap((n) => n.paragraphs.flatMap((q: any) => q.runs)).find((r: any) => r.text.trim());
  const firstPara = (doc: OmwDocument) => texts(doc).flatMap((n) => n.paragraphs).find((q: any) => q.runs.some((r: any) => r.text.trim()));
  const png = () => makeAsset(encodePng(new Uint8Array([255, 0, 0, 255]), 1, 1), "image/png", "omw-pic.png");
  const addPicture = (doc: OmwDocument) => {
    const a = png();
    doc.assets[a.id] = a;
    doc.pages[0].nodes.push(newImage(a.id, 20, 20));
  };

  // DOC (stage 2: body text alone is written into the DOC — tests/docWrite.test.ts; here only that it is not refused)
  const docWritten = async (edit: (doc: OmwDocument) => void) => {
    const { bytes, doc } = await open(repoFile("doc"), "doc");
    edit(doc);
    expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
    const out = await save(doc, "doc");
    expect(eq(out, bytes)).toBe(false);
    return (await open(out, "doc")).doc;
  };
  it("DOC: a letter typed (written, stage 2)", async () => {
    const back = await docWritten((d) => (firstRun(d).text += " omw"));
    expect(firstRun(back).text.endsWith(" omw")).toBe(true);
  });
  it("DOC: a letter deleted (written, stage 2)", async () => {
    const was = firstRun((await open(repoFile("doc"), "doc")).doc).text;
    expect(firstRun(await docWritten((d) => (firstRun(d).text = firstRun(d).text.slice(1)))).text).toBe(was.slice(1));
  });
  it("DOC: bold", () => refused("doc", (d) => (firstRun(d).bold = !firstRun(d).bold)));
  it("DOC: font size", () => refused("doc", (d) => (firstRun(d).fontSize = (firstRun(d).fontSize ?? 12) + 1)));
  it("DOC: text colour", () => refused("doc", (d) => (firstRun(d).color = "#c00000")));
  it("DOC: paragraph alignment", () => refused("doc", (d) => (firstPara(d).align = firstPara(d).align === "CENTER" ? "LEFT" : "CENTER")));
  it("DOC: paragraph spacing", () => refused("doc", (d) => (firstPara(d).spaceAfter = (firstPara(d).spaceAfter ?? 0) + 7)));
  it("DOC: a paragraph deleted (written, stage 2)", async () => {
    let gone = "";
    const back = await docWritten((d) => {
      const n = texts(d).find((x) => x.paragraphs.length > 2 && x.paragraphs[1].runs.some((r: any) => r.text));
      gone = n.paragraphs[1].runs.map((r: any) => r.text).join("");
      n.paragraphs.splice(1, 1);
    });
    expect(texts(back).flatMap((n) => n.paragraphs.map((p: any) => p.runs.map((r: any) => r.text).join("")))).not.toContain(gone);
  });
  it("DOC: a picture added", () => refused("doc", addPicture));
  it("DOC: a shape drawn", () => refused("doc", (d) => d.pages[0].nodes.push(newVector([{ closed: true, points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] } as any]))));
  it("DOC: page margins", () => refused("doc", (d) => d.pages.forEach((p) => (p.margins = { top: 10, right: 10, bottom: 10, left: 10, header: 5, footer: 5 }))));
  it("DOC: paper size", () => refused("doc", (d) => d.pages.forEach((p) => ([p.width, p.height] = [p.height, p.width]))));
  it("DOC: page colour", () => refused("doc", (d) => (d.pages[0].background = "#ffeecc")));
  it("DOC: a header", () => refused("doc", (d) => (d.pages[0].hf = { header: { default: [{ id: "h", runs: [{ text: "omw" }] } as any] } })));
  // (doc-write3: a cell's text is written — tests/docWrite3.test.ts; its look is not)
  it("DOC: a table cell's format (if the file has a table) or a frame moved", () =>
    refused("doc", (d) => {
      const table = d.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
      if (table) table.rows[0][0].bold = !table.rows[0][0].bold;
      else texts(d)[0].transform.x += 30;
    }));

  // XLS
  const sheet = (d: OmwDocument) => d.pages.find((p) => p.sheet)!.sheet!;
  const filled = (d: OmwDocument) => Object.keys(sheet(d).cells).find((a) => sheet(d).cells[a].v !== undefined)!;
  // (stage 2: cell values alone are written into the XLS — tests/xlsWrite.test.ts; here only that they are not refused)
  const written = async (edit: (doc: OmwDocument) => void) => {
    const { bytes, doc } = await open(repoFile("xls"), "xls");
    edit(doc);
    expect(legacyUnchanged(doc.pages, "xls")).toBe(false);
    const out = await save(doc, "xls");
    expect(eq(out, bytes)).toBe(false);
    return (await open(out, "xls")).doc;
  };
  it("XLS: a cell value (written, stage 2)", async () => {
    const back = await written((d) => (sheet(d).cells[filled(d)].v = "omw"));
    expect(sheet(back).cells[filled(back)].v).toBe("omw");
  });
  it("XLS: a new cell (written, stage 2)", async () => expect(sheet(await written((d) => (sheet(d).cells["Z99"] = { v: 1 }))).cells.Z99?.v).toBe(1));
  it("XLS: a cell cleared (written, stage 2)", async () => {
    let a = "";
    const back = await written((d) => {
      a = Object.keys(sheet(d).cells).find((k) => sheet(d).cells[k].v !== undefined && !sheet(d).cells[k].s)!;
      delete sheet(d).cells[a];
    });
    expect(sheet(back).cells[a]?.v).toBeUndefined();
  });
  it("XLS: a formula", () => refused("xls", (d) => (sheet(d).cells[filled(d)].f = "1+1")));
  it("XLS: a cell format", () =>
    refused("xls", (d) => {
      const s = sheet(d);
      s.styles.push({ bold: true });
      s.cells[filled(d)].s = s.styles.length - 1;
    }));
  it("XLS: a column width", () => refused("xls", (d) => (sheet(d).colW[0] = (sheet(d).colW[0] ?? 72) + 40)));
  it("XLS: a row height", () => refused("xls", (d) => (sheet(d).rowH[0] = 50)));
  it("XLS: merged cells", () => refused("xls", (d) => sheet(d).merges.push("A1:B2")));
  it("XLS: frozen panes", () => refused("xls", (d) => (sheet(d).freeze = { rows: 1, cols: 0 })));
  it("XLS: sheet renamed", () => refused("xls", (d) => (sheet(d).name = "omw")));
  it("XLS: sheet removed or added", () =>
    refused("xls", (d) => {
      if (d.pages.length > 1) d.pages.pop();
      else d.pages.push({ ...d.pages[0], id: "pg-omw", sheet: { ...sheet(d), name: "omw", cells: {} } } as Page);
    }));
  it("XLS: a picture on the page", () => refused("xls", addPicture));

  // PPT
  it("PPT: slide order", () =>
    refused("ppt", (d) => {
      expect(d.pages.length).toBeGreaterThan(1);
      d.pages.push(d.pages.shift()!);
    }));
  it("PPT: a slide deleted", () => refused("ppt", (d) => d.pages.pop()));
  it("PPT: a slide duplicated", () => refused("ppt", (d) => d.pages.push({ ...d.pages[0], id: "pg-omw" })));
  // (stage 2: slide text alone is written into the PPT — tests/pptWrite.test.ts; here only that it is not refused)
  it("PPT: text (written, stage 2)", async () => {
    const { bytes, doc } = await open(repoFile("ppt"), "ppt");
    // (opened with the formatting, pptRich.ts: a slide's own text box — the master's text drawn first is not written)
    const own = (d: OmwDocument) => texts(d).find((n) => n.ph)?.paragraphs[0].runs.find((r: any) => r.text.trim()) ?? firstRun(d);
    own(doc).text += " omw";
    const out = await save(doc, "ppt");
    expect(eq(out, bytes)).toBe(false);
    expect(own((await open(out, "ppt")).doc).text).toBe(own(doc).text);
  });
  it("PPT: italic", () => refused("ppt", (d) => (firstRun(d).italic = !firstRun(d).italic)));
  it("PPT: a text box moved", () => refused("ppt", (d) => (texts(d)[0].transform.x += 25)));
  it("PPT: a text box resized", () => refused("ppt", (d) => (texts(d)[0].width += 25)));
  it("PPT: a picture added", () => refused("ppt", addPicture));
  it("PPT: a transition", () => refused("ppt", (d) => (d.pages[0].transition = { type: "NONE", duration: 0 } as any)));
  it("PPT: slide background", () => refused("ppt", (d) => (d.pages[0].background = "#003366")));
  it("PPT: speaker notes", () => refused("ppt", (d) => (d.pages[0].notes = "omw")));
  it("PPT: a node hidden", () => refused("ppt", (d) => (texts(d)[0].visible = false)));
});

describe("what is not an edit, and what is refused outright", () => {
  it("ids and guides are not content", async () => {
    for (const kind of LEGACY_KINDS) {
      const { doc } = await open(repoFile(kind), kind);
      doc.pages.forEach((p, i) => {
        p.id = `pg-new-${i}`;
        p.guides = { x: [100] };
        p.nodes.forEach((n, j) => (n.id = `n-new-${i}-${j}`));
      });
      expect(legacyUnchanged(doc.pages, kind), kind).toBe(true);
    }
  });

  it("DOC: the same paragraphs cut into pages elsewhere are the same document", async () => {
    const { doc } = await open(repoFile("doc"), "doc");
    const before = legacyFingerprint("doc", doc.pages);
    // the body flow cut again elsewhere: the first frame's second half, cut inside a paragraph, on a new page
    const p0 = doc.pages[0];
    const frame = p0.nodes.find((n) => n.type === "TEXT") as any;
    const half = Math.ceil(frame.paragraphs.length / 2);
    const tail = frame.paragraphs.splice(half);
    const cut = frame.paragraphs[half - 1];
    const k = Math.max(1, Math.floor(cut.runs[0].text.length / 2));
    frame.paragraphs[half - 1] = { ...cut, runs: [{ ...cut.runs[0], text: cut.runs[0].text.slice(0, k) }], flowSplit: 2 };
    const cont = { ...cut, id: "p-cont", runs: [{ ...cut.runs[0], text: cut.runs[0].text.slice(k) }, ...cut.runs.slice(1)], flowCont: cut.id };
    const later = p0.nodes.filter((n) => n !== frame);
    p0.nodes = [frame];
    const pagesWere = doc.pages.length;
    doc.pages.splice(1, 0, { ...without(p0, ["hf", "notePr", "comments", "trackChanges"]), id: "pg-2", name: "omw · 2", breakBefore: "flow", nodes: [{ ...frame, id: "n-rest", paragraphs: [cont, ...tail] }, ...later] } as Page);
    expect(doc.pages.length).toBe(pagesWere + 1);
    expect(legacyFingerprint("doc", doc.pages)).toBe(before);
    expect(legacyUnchanged(doc.pages, "doc")).toBe(true);
    // … but the same cut with a letter changed is an edit (a new object, as the store's immer edits make: the flow
    // memoizes joined pieces by object)
    const rest = doc.pages[1].nodes[0] as any;
    rest.paragraphs = [{ ...cont, runs: [{ ...cont.runs[0], text: cont.runs[0].text + "x" }, ...cont.runs.slice(1)] }, ...tail];
    expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
  });

  it("a page from elsewhere is refused", async () => {
    for (const kind of LEGACY_KINDS) {
      const { doc } = await open(repoFile(kind), kind);
      doc.pages.push({ ...doc.pages[0], id: "other", source: { format: "docx", name: "omw-other.docx" }, nodes: [] } as Page);
      await expect(save(doc, kind), kind).rejects.toThrow();
    }
  });

  it("a document not from the file is refused", async () => {
    for (const kind of LEGACY_KINDS) {
      const { doc } = await open(repoFile(kind), kind);
      doc.pages.forEach((p) => p.source && delete p.source.legacy);
      await expect(save(doc, kind), kind).rejects.toThrow();
    }
  });

  it("a decrypted copy is never kept", async () => {
    for (const kind of LEGACY_KINDS) {
      const { doc } = await open(repoFile(kind), kind, { decrypted: true });
      expect(legacySource(doc.pages), kind).toBeUndefined();
    }
  });

  it("password-protected files offer no original-format save", async () => {
    const flagged = (kind: LegacyKind): Uint8Array => {
      const bytes = new Uint8Array(readFileSync(repoFile(kind)));
      const tree = readCfbTree(bytes);
      const stream = (name: string) => tree.root.kids!.find((k) => k.name === name)!;
      if (kind === "doc") {
        const wd = stream("WordDocument");
        wd.data = wd.data!.slice();
        wd.data[0x0b] |= 0x01; // FIB fEncrypted (0x0100)
      } else if (kind === "xls") {
        const wb = stream("Workbook");
        // FILEPASS (0x002F, XOR) right after the globals' BOF record
        const bofLen = wb.data![2] | (wb.data![3] << 8);
        const at = 4 + bofLen;
        const fp = [0x2f, 0x00, 0x06, 0x00, 0x00, 0x00, 0x34, 0x12, 0x78, 0x56];
        wb.data = new Uint8Array([...wb.data!.subarray(0, at), ...fp, ...wb.data!.subarray(at)]);
      } else tree.root.kids!.push({ name: "EncryptedSummary", kind: "stream", clsid: new Uint8Array(16), stateBits: 0, created: new Uint8Array(8), modified: new Uint8Array(8), data: new Uint8Array(64) });
      return writeCfb(tree);
    };
    for (const kind of LEGACY_KINDS) {
      const bytes = flagged(kind);
      expect(legacyKeepable(kind, bytes), kind).toBe(false);
      expect(legacyKeepable(kind, new Uint8Array(readFileSync(repoFile(kind)))), kind).toBe(true);
      let pages: Page[] = [];
      try {
        pages = (await open(bytes, kind)).doc.pages;
      } catch {
        pages = []; // refused outright is fine too
      }
      expect(legacySource(pages), kind).toBeUndefined();
    }
  });

  it("other files are not kept as a legacy original", () => {
    for (const kind of LEGACY_KINDS) {
      expect(legacyKeepable(kind, new Uint8Array(1024))).toBe(false);
      const other = LEGACY_KINDS.find((k) => k !== kind)!;
      expect(legacyKeepable(kind, new Uint8Array(readFileSync(repoFile(other)))), `${other} as ${kind}`).toBe(false);
    }
    expect(readCfb(new Uint8Array(readFileSync(repoFile("doc")))).get("WordDocument")).toBeTruthy();
  });

  it("the save messages are there in every language", () => {
    for (const lang of ["ko", "en", "zh", "ja"] as const)
      for (const kind of LEGACY_KINDS)
        for (const k of ["format.level", "export.label", "export.hint", "filter", "saved", "err.notFrom", "err.noOriginal", "err.edited"]) expect(DICTS[lang][`legacysave.${k}.${kind}`], `${lang} ${k} ${kind}`).toBeTruthy();
  });
});
