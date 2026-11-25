// Phone editor (docs/MOBILE_PLAN.md §3.8): the phone's own open → edit → save path (ui/mobile/editor/session.ts,
// ops.ts) on the desktop engine — every format opened, edited once with the phone's commands and saved the phone's
// way, then read again with the desktop importer. With OMW_MOBILE_OUT=<folder> the files the Android app saved in its
// end-to-end check (scripts/mobile-edit-e2e.mjs) are read back here too.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
// (the PDF surgeon''s fallback font: the app fetches it, a test reads the file)
vi.mock("../src/io/pretendard", async (orig) => ({ ...(await orig<any>()), pretendardTtf: async (w: string) => new Uint8Array(readFileSync(`assets/fonts/Pretendard-${w === "bold" ? "Bold" : "Regular"}.ttf`)) }));
import { useLang } from "../src/i18n";
import { useStore } from "../src/core/store";
import type { Page, TextNode, VectorNode } from "../src/core/types";
import { editParagraph, formatRuns, paragraphText, retypeRuns, updateGroup, updateNodes, deleteNodes, duplicateNodes, beginXform, updateXform, endXform, measure } from "../src/ui/mobile/editor/ops";
import { openForEdit, produce, isEdited, psdSize } from "../src/ui/mobile/editor/session";
import { formatForExt } from "../src/io/formats";
import { readDxf } from "../src/io/formats/dxf";
import { buildCadPages } from "../src/io/formats/cad/build";
import { writeDxf, dxfString, nearestAci } from "../src/io/formats/cad/dxfWrite";
import { makeAsset } from "../src/core/assets";
import { installDom, installPdfWorker } from "./coverage/helpers";

useLang.getState().set("ko", false);
const S = () => useStore.getState();
const read = (p: string) => new Uint8Array(readFileSync(p));
const KO = "qa/samples/store-sample/ko";
const MARK = "OMW모바일";

beforeAll(async () => {
  installDom();
  await installPdfWorker();
});

const textOf = (pages: Page[]) =>
  pages
    .flatMap((p) => p.nodes)
    .filter((n): n is TextNode => n.type === "TEXT")
    .map((n) => n.paragraphs.map((q) => q.runs.map((r) => r.text).join("")).join("\n"))
    .join("\n");

async function reopen(name: string, bytes: Uint8Array): Promise<Page[]> {
  const ext = name.split(".").pop()!.toLowerCase();
  const r = await formatForExt(ext)!.open({ name, path: null, bytes }, { confirm: () => true });
  return r.pages ?? [];
}

/** Edit the first paragraph with text on any page: the mark in front of it. */
function markFirstText(): { before: string } {
  const s = S();
  for (const p of s.doc.pages) {
    const n = p.nodes.find((x): x is TextNode => x.type === "TEXT" && x.paragraphs.some((q) => q.runs.some((r) => r.text.trim())));
    if (!n) continue;
    const i = n.paragraphs.findIndex((q) => q.runs.some((r) => r.text.trim()));
    S().set({ pageId: p.id });
    const before = paragraphText(n, i);
    expect(editParagraph(n.id, i, { text: MARK + before })).toBe(true);
    return { before };
  }
  throw new Error("no text");
}

describe("phone text commands", () => {
  const run = (text: string, bold = false) => ({ text, fontFamily: "Pretendard", fontSize: 16, bold, italic: false, underline: false, color: "#000000" });
  it("retyping keeps the formats of the untouched text", () => {
    const runs = [run("Hello "), run("bold", true), run(" world")];
    const out = retypeRuns(runs, "Hello bolder world");
    expect(out.map((r) => r.text)).toEqual(["Hello ", "bolder", " world"]);
    expect(out[1].bold).toBe(true);
    expect(retypeRuns(runs, "Hello world").map((r) => r.text).join("")).toBe("Hello world");
    expect(retypeRuns([run("")], "가나다")[0].text).toBe("가나다");
    // Hangul being composed: each keystroke is one more retype of the same paragraph
    let r = [run("회의록")];
    for (const s of ["회의록 ㅁ", "회의록 모", "회의록 모바", "회의록 모바일"]) r = retypeRuns(r, s);
    expect(r.map((x) => x.text).join("")).toBe("회의록 모바일");
  });
  it("a format range splits and joins runs", () => {
    const out = formatRuns([run("abcdef")], 2, 4, { bold: true });
    expect(out.map((r) => [r.text, r.bold])).toEqual([["ab", false], ["cd", true], ["ef", false]]);
    const back = formatRuns(out, 2, 4, { bold: false });
    expect(back.map((r) => r.text)).toEqual(["abcdef"]);
    expect(formatRuns([run("abc")], 0, 0, { fontSize: 30 })[0].fontSize).toBe(30);
  });
});

describe("open → edit → save (phone path) → read again (desktop)", () => {
  it("DOCX: a paragraph retyped, saved into the original package", async () => {
    const ses = await openForEdit("omni-store-sample.docx", read(`${KO}/omni-store-sample.docx`));
    // unedited: the original bytes
    expect((await produce("same", ses, () => true)).bytes).toBe(ses.original);
    markFirstText();
    expect(isEdited(ses)).toBe(true);
    const out = await produce("same", ses, () => true);
    expect(out.name).toBe("omni-store-sample.docx");
    expect(textOf(await reopen(out.name, out.bytes))).toContain(MARK);
    // undo back to the file as opened: unedited again
    S().undo();
    expect(isEdited(ses)).toBe(false);
  });

  it("HWPX: a paragraph retyped and made bold", async () => {
    const ses = await openForEdit("omni-sample.hwpx", read("qa/samples/doc-features/omni-sample.hwpx"));
    markFirstText();
    const s = S();
    const p = s.doc.pages.find((x) => x.id === s.pageId)!;
    const n = p.nodes.find((x): x is TextNode => x.type === "TEXT" && paragraphText(x, 0).includes(MARK) || (x.type === "TEXT" && x.paragraphs.some((q, i) => paragraphText(x, i).startsWith(MARK))))!;
    const i = n.paragraphs.findIndex((_, k) => paragraphText(n, k).startsWith(MARK));
    editParagraph(n.id, i, { format: { a: 0, b: MARK.length, patch: { bold: true } } });
    const out = await produce("same", ses, () => true);
    const back = await reopen(out.name, out.bytes);
    expect(textOf(back)).toContain(MARK);
    const bn = back.flatMap((x) => x.nodes).find((x): x is TextNode => x.type === "TEXT" && textOf([{ ...p, nodes: [x] }]).includes(MARK))!;
    const r = bn.paragraphs.flatMap((q) => q.runs).find((x) => x.text.includes(MARK.slice(0, 3)))!;
    expect(r.bold).toBe(true);
  });

  it("PPTX: slide text retyped and a shape moved, rotated and scaled", async () => {
    const ses = await openForEdit("omni-store-slides.pptx", read(`${KO}/omni-store-slides.pptx`));
    markFirstText();
    const p = S().doc.pages.find((x) => x.id === S().pageId)!;
    const target = p.nodes.find((n) => n.type === "TEXT")!;
    const x = beginXform([target.id])!;
    updateXform(x, 30, 12, 1.1, 0);
    endXform();
    const out = await produce("same", ses, () => true);
    const back = await reopen(out.name, out.bytes);
    expect(textOf(back)).toContain(MARK);
  });

  it("XLSX: a cell value typed, saved into the workbook", async () => {
    const ses = await openForEdit("xls-01-two-sheets.xlsx", read("qa/interop/omniweave-made/xls-01-two-sheets.xlsx"));
    const { enterText } = await import("../src/ui/sheet/sheetActions");
    const page = S().doc.pages.find((p) => p.sheet)!;
    S().set({ pageId: page.id });
    expect(enterText(page.id, 0, 0, "4242")).toBe(true);
    expect(enterText(page.id, 1, 0, MARK)).toBe(true);
    const out = await produce("same", ses, () => true);
    const back = await reopen(out.name, out.bytes);
    const sh = back.find((p) => p.sheet && p.name === page.name)!.sheet!;
    expect(sh.cells["A1"]?.v).toBe(4242);
    expect(sh.cells["A2"]?.v).toBe(MARK);
  });

  it("PSD: layer opacity, visibility and order changed, written as PSD again", async () => {
    const bytes = read(`${KO}/omni-store-layers.psd`);
    expect(psdSize(bytes)!.w).toBeGreaterThan(0);
    const ses = await openForEdit("omni-store-layers.psd", bytes);
    const p = S().doc.pages[0];
    S().set({ pageId: p.id });
    const layers = p.nodes.filter((n) => n.type === "RASTER" && !n.psdText);
    expect(layers.length).toBeGreaterThan(1);
    const a = layers[1];
    updateNodes([a.id], "opacity", (n) => (n.opacity = 0.5));
    updateNodes([layers[2].id], "hide", (n) => (n.visible = false));
    const out = await produce("same", ses, () => true);
    expect(out.name).toBe("omni-store-layers.psd");
    const back = (await reopen(out.name, out.bytes))[0];
    const ba = back.nodes.find((n) => n.name === a.name)!;
    expect(ba.opacity).toBeCloseTo(0.5, 1);
    expect(back.nodes.find((n) => n.name === layers[2].name)!.visible).toBe(false);
  });

  it("PSD: a text layer's words changed (Photoshop text data written back)", async () => {
    const ses = await openForEdit("omni-store-layers.psd", read(`${KO}/omni-store-layers.psd`));
    const p = S().doc.pages[0];
    const tl = p.nodes.find((n) => n.type === "RASTER" && n.psdText);
    if (!tl || tl.type !== "RASTER") return; // the sample has none
    // (drawing the new words needs a canvas: here the spec alone, as the writer reads it)
    updateNodes([tl.id], "text", (n) => (n.psdText.text = MARK));
    const out = await produce("same", ses, () => true);
    const back = (await reopen(out.name, out.bytes))[0];
    const bt = back.nodes.find((n) => n.type === "RASTER" && n.psdText && n.name === tl.name);
    expect(bt && bt.type === "RASTER" ? bt.psdText!.text : "").toContain(MARK);
  });

  it("AI (PDF compatible) and PDF: text promoted, retyped, saved by the PDF surgeon", async () => {
    const { elevatePdfText } = await import("../src/io/pdf");
    for (const [name, path] of [
      ["omni-store-design.ai", `${KO}/omni-store-design.ai`],
      ["omni-store-sample.pdf", `${KO}/omni-store-sample.pdf`],
    ]) {
      const ses = await openForEdit(name, read(path));
      const page = S().doc.pages[0];
      const pdfNode = page.nodes.find((n) => n.type === "PDF")!;
      if (pdfNode.type !== "PDF") throw new Error("no PDF node");
      const { nodes, covers } = await elevatePdfText(S().doc.assets[pdfNode.assetId].hash, pdfNode.pageIndex, page.width);
      expect(nodes.length).toBeGreaterThan(0);
      S().commit("elevate", (d) => {
        const pg = d.pages[0];
        (pg.nodes.find((x) => x.id === pdfNode.id) as any).covers = covers;
        pg.nodes.push(...(nodes as any));
      });
      // the AI sample's only text lies under a picture band painted after it (not seen on the page): it stays in the
      // background; its five gradient shapes come up as objects instead — one is deleted
      const isGrad = (n: any) => n.type === "VECTOR" && n.fills?.[0]?.type === "gradient";
      const ai = name.endsWith(".ai");
      if (ai) {
        expect(nodes.filter(isGrad).length).toBe(5);
        const gone = nodes.find(isGrad)!.id;
        S().commit("delete", (d) => {
          d.pages[0].nodes = d.pages[0].nodes.filter((x) => x.id !== gone);
        });
      } else markFirstText();
      const out = await produce("same", ses, () => true);
      expect(out.name.endsWith(name.slice(-3))).toBe(true);
      const again = await openForEdit(out.name, out.bytes);
      const pg = S().doc.pages[0];
      const pn = pg.nodes.find((n) => n.type === "PDF")!;
      if (pn.type !== "PDF") throw new Error("no PDF node");
      const el = await elevatePdfText(S().doc.assets[pn.assetId].hash, pn.pageIndex, pg.width);
      if (ai) expect(el.nodes.filter(isGrad).length).toBe(4);
      else expect(textOf([{ ...pg, nodes: el.nodes }])).toContain(MARK);
      expect(again.name).toBe(out.name);
    }
  });

  it("DXF: layer off and recoloured, a line moved, an object deleted and one copied → DXF export → read again", async () => {
    const ses = await openForEdit("omni-store-drawing.dxf", read(`${KO}/omni-store-drawing.dxf`));
    const page = S().doc.pages[0];
    S().set({ pageId: page.id });
    const layers = (page.groups ?? []).filter((g) => !g.parentId && g.cad?.layer);
    expect(layers.length).toBeGreaterThan(1);
    const L = layers[1];
    updateGroup(L.id, "off", (g) => (g.visible = false));
    updateGroup(layers[0].id, "colour", (g) => (g.cad.color = "#ff0000"));
    const vec = page.nodes.find((n): n is VectorNode => n.type === "VECTOR" && n.stroke !== null)!;
    const x = beginXform([vec.id])!;
    updateXform(x, 50, 0);
    endXform();
    const victim = page.nodes.filter((n) => n.type === "VECTOR")[2];
    deleteNodes([victim.id]);
    duplicateNodes([vec.id]);
    // the phone does not write DWG / DXF as "the original format": that would drop what the drawing has beyond this
    const same = await produce("same", ses, () => true).catch((e) => e);
    expect(same).toBeInstanceOf(Error);
    const out = await produce("dxf", ses, () => true);
    expect(out.name).toBe("omni-store-drawing.dxf");
    const d = readDxf(out.bytes);
    // the drawing export is DXF 2000 (hatches, blocks, lineweights kept; cad/dxfWrite2000.ts)
    expect(d.version).toMatch(/^AC101[58]$/);
    const built = buildCadPages(d, { name: "back", format: "dxf", asset: makeAsset(out.bytes, "image/vnd.dxf", "back.dxf") });
    const bp = built.pages[0];
    const bl = (bp.groups ?? []).find((g) => g.cad?.layer?.toUpperCase() === L.cad!.layer!.toUpperCase())!;
    expect(bl.visible).toBe(false);
    const b0 = (bp.groups ?? []).find((g) => g.cad?.layer?.toUpperCase() === layers[0].cad!.layer!.toUpperCase())!;
    expect(b0.cad!.color).toBe("#ff0000");
    // the texts come back with their words
    const words = textOf([S().doc.pages[0]]).replace(/\s+/g, "");
    const backWords = textOf(built.pages).replace(/\s+/g, "");
    for (const w of words.slice(0, 40).match(/[가-힣A-Za-z0-9]{2,}/g) ?? []) expect(backWords).toContain(w);
    // measuring in drawing units
    const m = measure(page, [0, 0], [page.source!.cad!.k * 10, 0]);
    expect(m.value).toBeCloseTo(10, 6);
  });

  it("DWG: opened, edited, exported as DXF and .omw (no DWG writer)", async () => {
    // a DWG of our own when this PC has one, else AutoCAD's own sample drawing (read where it is installed, never copied)
    const dir = "qa/interop/autocad-made";
    const own = existsSync(dir) ? readdirSync(dir).find((x) => /-2018\.dwg$/i.test(x)) : undefined;
    const path = own ? join(dir, own) : [process.env.OMW_DWG_SAMPLE, "E:/Autodesk/AutoCAD 2027/Sample/Database Connectivity/Floor Plan Sample.dwg"].find((x) => x && existsSync(x));
    if (!path) return;
    const f = path.split(/[\\/]/).pop()!;
    const ses = await openForEdit(f, read(path));
    const page = S().doc.pages[0];
    const g = (page.groups ?? []).find((x) => x.cad?.layer);
    if (g) updateGroup(g.id, "off", (x) => (x.visible = false));
    const dxf = await produce("dxf", ses, () => true);
    expect(readDxf(dxf.bytes).version).toMatch(/^AC101[58]$/);
    const omw = await produce("omw", ses, () => true);
    expect(omw.name.endsWith(".omw")).toBe(true);
    const back = await openForEdit(omw.name, omw.bytes);
    expect(back.loaded.pages.length).toBe(S().doc.pages.length);
  });
});

describe("DXF writer pieces", () => {
  it("strings, layer names and colours", () => {
    expect(dxfString("가A")).toBe("가A");
    expect(dxfString("😀")).toBe("\\U+D83D\\U+DE00");
    expect(nearestAci("#ff0000")).toBe(1);
    expect(nearestAci("#000000")).toBe(7);
  });
  it("an empty page still makes a readable DXF", () => {
    const page: Page = { id: "p", name: "p", kind: "DESIGN", width: 400, height: 300, background: "#fff", nodes: [], masterId: null, transition: { type: "NONE", duration: 0 }, animations: [] };
    const r = writeDxf(page);
    expect(readDxf(r.bytes).version).toBe("AC1009");
  });
});

// files the Android app saved in its end-to-end check, read back with the desktop importers
const OUT = process.env.OMW_MOBILE_OUT;
describe.skipIf(!OUT || !existsSync(OUT))("files saved on the phone (OMW_MOBILE_OUT)", () => {
  for (const f of OUT && existsSync(OUT) ? readdirSync(OUT).filter((x) => !x.startsWith(".") && !x.endsWith(".json")) : []) {
    it(f, async () => {
      const bytes = read(join(OUT!, f));
      const ext = f.split(".").pop()!.toLowerCase();
      if (ext === "png" || ext === "jpg") return expect(bytes.length).toBeGreaterThan(1000);
      if (ext === "dxf") return expect(readDxf(bytes).version).toBe("AC1009");
      const ses = await openForEdit(f, bytes);
      expect(ses.loaded.pages.length).toBeGreaterThan(0);
      if (/\.(docx|hwpx|pptx)$/i.test(f)) expect(textOf(ses.loaded.pages)).toContain(MARK);
      if (/\.xlsx$/i.test(f)) expect(JSON.stringify(ses.loaded.pages.map((p) => p.sheet?.cells ?? {}))).toContain(MARK);
      if (/\.(pdf|ai)$/i.test(f)) {
        // the typed words are in the page's content: the text promotion finds them again
        const { elevatePdfText } = await import("../src/io/pdf");
        const pg = ses.loaded.pages[0];
        const pn = pg.nodes.find((n) => n.type === "PDF");
        if (pn?.type !== "PDF") throw new Error("no PDF node");
        const el = await elevatePdfText(ses.loaded.assets[pn.assetId].hash, pn.pageIndex, pg.width);
        expect(textOf([{ ...pg, nodes: el.nodes }])).toContain(MARK);
      }
      if (/\.psd$/i.test(f)) expect(ses.loaded.pages[0].nodes.some((n) => Math.abs(n.opacity - 0.5) < 0.01)).toBe(true);
      if (/\.omw$/i.test(f)) expect(ses.loaded.pages[0].groups?.some((g) => g.cad && !g.visible)).toBe(true);
    });
  }
});
