// Accessibility tags (src/io/pdfsurgeon/tags.ts), comment data files (xfdf.ts), replies / states / measurements
// (annots.ts): written, then read back with pdf.js / pdf-lib and the readers themselves.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, PDFString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { addAnnots } from "../../src/io/pdfsurgeon/annots";
import { openSurgeonDoc } from "../../src/io/pdfsurgeon/document";
import { autoTag, findColumns, isTagged, readingOrder, setAltText } from "../../src/io/pdfsurgeon/tags";
import { parseComments, readComments, toFdf, toXfdf } from "../../src/io/pdfsurgeon/xfdf";
import { measureLabel } from "../../src/ui/pdf/pdfToolsStore";
import { openJs } from "./helpers";

async function report(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText("Annual Report", { x: 72, y: 760, size: 24, font: f });
  p.drawText("The first paragraph starts here and", { x: 72, y: 720, size: 11, font: f });
  p.drawText("goes on to a second line.", { x: 72, y: 706, size: 11, font: f });
  p.drawText("Results", { x: 72, y: 660, size: 16, font: f });
  p.drawText("Another paragraph after the heading.", { x: 72, y: 636, size: 11, font: f });
  const q = d.addPage([595, 842]);
  q.drawText("Page two text.", { x: 72, y: 760, size: 11, font: f });
  return d.save();
}

async function textOf(bytes: Uint8Array, page = 1) {
  const d = await openJs(bytes);
  const c = await (await d.getPage(page)).getTextContent();
  return (c.items as { str: string }[]).map((i) => i.str).join("|");
}

describe("autoTag / readingOrder", () => {
  it("tags headings and paragraphs in reading order, the page unchanged", async () => {
    const src = await report();
    expect(await isTagged(src)).toBe(false);
    expect((await readingOrder(src)).tagged).toBe(false);
    const r = await autoTag(src);
    expect(r.already).toBe(false);
    expect(r.items.map((i) => i.role)).toEqual(["H1", "P", "H2", "P", "P"]);
    expect(r.items[1].text).toBe("The first paragraph starts here and goes on to a second line.");
    expect(r.items[4].page).toBe(1);
    // the same text shown, now inside marked content
    expect(await textOf(r.bytes)).toBe(await textOf(src));
    const back = await readingOrder(r.bytes);
    expect(back.tagged).toBe(true);
    expect(back.items).toEqual(r.items);
    // pdf.js sees the structure tree
    const js = await openJs(r.bytes);
    const tree = await (await js.getPage(1)).getStructTree();
    const doc = tree.children[0];
    expect(doc.role).toBe("Document");
    expect(doc.children.map((c: { role: string }) => c.role)).toEqual(["H1", "P", "H2", "P"]);
    const md = await js.getMarkInfo();
    expect(md?.Marked).toBe(true);
    // a second run leaves the file alone
    const again = await autoTag(r.bytes);
    expect(again.already).toBe(true);
    expect(again.bytes).toBe(r.bytes);
  });
});

// a 1×1 red PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64"));

async function columns(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([595, 842]);
  p.drawText("Two Column Newsletter", { x: 50, y: 780, size: 24, font: f });
  const col = (x: number, tag: string) => {
    let y = 730;
    for (const para of [0, 1]) {
      for (let k = 0; k < 5; k++, y -= 14) p.drawText(`${tag}${para + 1} line ${k + 1} of the column text`, { x, y, size: 11, font: f });
      y -= 20;
    }
  };
  col(50, "L");
  col(320, "R");
  p.drawText("Footer across the whole page width, below both columns of the text", { x: 50, y: 520, size: 11, font: f });
  // a picture and a form XObject with text
  const img = await d.embedPng(PNG);
  p.drawImage(img, { x: 50, y: 300, width: 120, height: 90 });
  const src = await PDFDocument.create();
  const sf = await src.embedFont(StandardFonts.Helvetica);
  src.addPage([300, 100]).drawText("Text inside a form", { x: 10, y: 40, size: 11, font: sf });
  const [form] = await d.embedPdf(await src.save());
  p.drawPage(form, { x: 50, y: 150 });
  return d.save();
}

describe("autoTag: columns, figures, forms", () => {
  it("finds the gutter of two columns", () => {
    const b = (x0: number, y: number, x1: number) => ({ box: [x0, y, x1, y + 10] as [number, number, number, number] });
    const cols = findColumns([b(50, 700, 270), b(50, 686, 268), b(50, 672, 265), b(320, 700, 545), b(320, 686, 540), b(320, 672, 530), b(50, 760, 400)]);
    expect(cols.length).toBe(2);
    expect(cols[0][1]).toBeGreaterThan(270);
    expect(cols[1][0]).toBeLessThan(320);
  });

  it("reads column by column, tags the picture as a Figure and the form's text", async () => {
    const r = await autoTag(await columns());
    const roles = r.items.map((i) => i.role);
    const texts = r.items.map((i) => i.text);
    expect(roles[0]).toBe("H1");
    expect(texts.slice(1, 5).map((t) => t.slice(0, 2))).toEqual(["L1", "L2", "R1", "R2"]);
    expect(texts[5]).toMatch(/^Footer across/);
    expect(roles).toContain("Figure");
    expect(texts).toContain("Text inside a form");
    // read back the same, then the figure's alternate text
    const back = await readingOrder(r.bytes);
    expect(back.items.map((i) => i.text)).toEqual(texts);
    const fig = back.items.find((i) => i.role === "Figure")!;
    expect(fig.ref).toBeTruthy();
    const withAlt = await setAltText(r.bytes, fig.ref!, "빨간 네모 그림");
    expect((await readingOrder(withAlt)).items.find((i) => i.role === "Figure")?.alt).toBe("빨간 네모 그림");
    const js = await openJs(withAlt);
    const tree = await (await js.getPage(1)).getStructTree();
    const figJs = tree.children[0].children.find((c: { role: string }) => c.role === "Figure");
    expect(figJs?.alt).toBe("빨간 네모 그림");
  });
});

describe("autoTag inside form XObjects", () => {
  const forms = () => new Uint8Array(readFileSync(join(process.cwd(), "qa/interop/omniweave-made/omni-tag-forms.pdf")));
  it("splits a whole page set in one form into heading, paragraphs and figure, in the form's own stream", async () => {
    const src = forms();
    const r = await autoTag(src);
    const p1 = r.items.filter((i) => i.page === 0);
    expect(p1.map((i) => i.role)).toEqual(["H1", "P", "P", "Figure"]);
    expect(p1[1].text).toBe("Form paragraph 1 line 1 goes on here. Form paragraph 1 line 2 goes on here. Form paragraph 1 line 3 goes on here. Form paragraph 1 line 4 goes on here.");
    // the elements point into the form (MCR /Stm), the form has its own /StructParents
    const d = await PDFDocument.load(r.bytes);
    let mcr = 0, formsTagged = 0;
    for (const [, o] of d.context.enumerateIndirectObjects()) {
      if (o instanceof PDFDict && o.get(PDFName.of("Type")) === PDFName.of("StructElem")) {
        const k = o.get(PDFName.of("K"));
        const list = k instanceof PDFArray ? k.asArray() : [k];
        mcr += list.filter((x) => x instanceof PDFDict && x.get(PDFName.of("Stm"))).length;
      }
      if (o instanceof PDFStream && o.dict.get(PDFName.of("StructParents")) !== undefined) formsTagged++;
    }
    expect(mcr).toBeGreaterThan(5);
    expect(formsTagged).toBe(3); // page 1's form, page 2's outer form and the form inside it (the stamp drawn twice: not)
    // read back the same, and the text still shows the same
    expect((await readingOrder(r.bytes)).items.map((i) => i.text)).toEqual(r.items.map((i) => i.text));
    expect(await textOf(r.bytes)).toBe(await textOf(src));
  });

  it("tags a form inside a form apart, and a form drawn twice where it is drawn", async () => {
    const r = await autoTag(forms());
    const p2 = r.items.filter((i) => i.page === 1).map((i) => i.text);
    expect(p2).toEqual(["Omni outer form text", "Omni nested inner form text", "Omni repeated stamp", "Omni repeated stamp"]);
    expect((await readingOrder(r.bytes)).items.filter((i) => i.page === 1).map((i) => i.text)).toEqual(p2);
  });
});

describe("comments: replies, states, measurements, XFDF / FDF", () => {
  it("writes replies and states, exports and parses them back", async () => {
    const src = await report();
    const sd = await openSurgeonDoc(src);
    const { bytes } = await addAnnots(
      sd,
      new Map([
        [
          0,
          [
            { id: "n1", kind: "note", at: [100, 600], color: [1, 0.82, 0.16], contents: "Check this", author: "QA", replies: [{ id: "r1", contents: "Done", author: "Dev" }], state: "Accepted" },
            { id: "m1", kind: "measure", points: [72, 500, 355.465, 500], shape: "line", color: [0.85, 0.1, 0.1], contents: "100.0 mm" },
            { id: "m2", kind: "measure", points: [100, 300, 200, 300, 200, 400, 100, 400], shape: "polygon", color: [0.85, 0.1, 0.1], contents: "12.45 cm²" },
          ],
        ],
      ]),
    );
    const list = await readComments(bytes);
    const note = list.find((x) => x.subtype === "Text" && !x.inReplyTo)!;
    expect(note.contents).toBe("Check this");
    expect(list.find((x) => x.inReplyTo === note.name && x.contents === "Done")).toBeTruthy();
    expect(list.find((x) => x.inReplyTo === note.name && x.state === "Accepted")).toBeTruthy();
    expect(list.find((x) => x.subtype === "Line")?.points).toEqual([72, 500, 355.465, 500]);
    expect(list.find((x) => x.subtype === "Polygon")?.points?.length).toBe(8);
    for (const data of [new TextEncoder().encode(toXfdf(list, "a.pdf")), toFdf(list, "a.pdf")]) {
      const back = parseComments(data);
      expect(back.map((x) => x.subtype).sort()).toEqual(list.map((x) => x.subtype).sort());
      expect(back.find((x) => x.state === "Accepted")?.inReplyTo).toBe(note.name);
      expect(back.find((x) => x.subtype === "Line")?.contents).toBe("100.0 mm");
    }
  });

  it("writes the scale as /Measure (Acrobat's rectilinear measure) and reads it back", async () => {
    const sd = await openSurgeonDoc(await report());
    const scale = { page: 1, pageUnit: "mm", real: 1, realUnit: "m" };
    const { bytes } = await addAnnots(sd, new Map([[0, [{ id: "m1", kind: "measure" as const, points: [72, 500, 355.465, 500], shape: "line" as const, color: [0.85, 0.1, 0.1] as [number, number, number], contents: "100.0 m", scale }]]]));
    const d = await PDFDocument.load(bytes);
    const an = d.context.lookup((d.getPage(0).node.get(PDFName.of("Annots")) as PDFArray).get(0)) as PDFDict;
    const m = an.lookup(PDFName.of("Measure"), PDFDict);
    expect(m.get(PDFName.of("Subtype"))).toBe(PDFName.of("RL"));
    expect((m.get(PDFName.of("R")) as PDFString).decodeText()).toBe("1 mm = 1 m");
    const x = (m.lookup(PDFName.of("X"), PDFArray).get(0) as PDFDict);
    expect((x.get(PDFName.of("C")) as PDFNumber).asNumber()).toBeCloseTo(25.4 / 72, 6); // 1 pt = 0.3528 mm on the page = 0.3528 m
    expect((x.get(PDFName.of("U")) as PDFString).decodeText()).toBe("m");
    expect(((m.lookup(PDFName.of("A"), PDFArray).get(0) as PDFDict).get(PDFName.of("U")) as PDFString).decodeText()).toBe("sq m");
    // 283.465 pt (100 mm on the page) through X: 100 m
    expect(283.465 * (x.get(PDFName.of("C")) as PDFNumber).asNumber()).toBeCloseTo(100, 2);
    const back = await readComments(bytes);
    expect(back[0].scale).toEqual(scale);
    expect(back[0].intent).toBe("LineDimension");
    // XFDF <measure rateValue> and FDF /Measure carry it too
    const xml = toXfdf(back, "a.pdf");
    expect(xml).toMatch(/<measure rateValue="1 mm = 1 m"><area [^>]*u="sq m"\/><distance [^>]*u="m"\/><xformat c="0\.35277778"/);
    for (const data of [new TextEncoder().encode(xml), toFdf(back, "a.pdf")]) {
      const x = parseComments(data)[0];
      expect(x.scale).toEqual(scale);
      expect(x.intent).toBe("LineDimension");
    }
  });

  it("measures with a scale", () => {
    const mm = { page: 1, pageUnit: "mm" as const, real: 1, realUnit: "mm" as const };
    expect(measureLabel("distance", [0, 0, 283.465, 0], mm)).toBe("100.0 mm");
    expect(measureLabel("area", [0, 0, 100, 0, 100, 100, 0, 100], { ...mm, realUnit: "m" })).toBe("1244.5 m²");
    expect(measureLabel("perimeter", [0, 0, 100, 0, 100, 100], { page: 1, pageUnit: "cm", real: 2, realUnit: "m" })).toBe("14.11 m");
  });
});
