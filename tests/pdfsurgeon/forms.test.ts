// AcroForm filling (src/io/pdfsurgeon/forms.ts) on Acrobat-made forms: the fields are listed with their values,
// filling writes one incremental update (original bytes untouched as a prefix), and the written values and
// appearances read back — in our reader and in pdf.js.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillForm, formFields, openSurgeonDoc } from "../../src/io/pdfsurgeon";
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { fallbackFont, openJs } from "./helpers";

const dir = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const load = (f: string) => new Uint8Array(readFileSync(join(dir, f)));

/** every glyph of every embedded TrueType program decodes (fontkit's short-loca subset bug left Hangul blank) */
async function embeddedGlyphsIntact(bytes: Uint8Array): Promise<number> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  let n = 0;
  for (const [, o] of pdf.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || String(o.get(PDFName.of("Type"))) !== "/FontDescriptor") continue;
    const ff = o.lookup(PDFName.of("FontFile2"));
    if (!(ff instanceof PDFRawStream)) continue;
    const font: any = fontkit.create(Buffer.from(decodePDFRawStream(ff).decode()) as any);
    for (let g = 0; g < font.numGlyphs; g++) void font.getGlyph(g).path;
    n++;
  }
  return n;
}
const byName = (fs: { name: string }[]) => new Map(fs.map((f) => [f.name, f as any]));

describe("PDF forms", () => {
  it("lists the fields of an Acrobat form with kinds, options and widgets", async () => {
    const { fields, xfa } = formFields(await openSurgeonDoc(load("acro_forms_rich.pdf")));
    expect(xfa).toBe(false);
    const m = byName(fields);
    expect([...m.keys()].sort()).toEqual(["agree", "dept", "grade", "memo", "name", "topics"]);
    expect(m.get("name").kind).toBe("text");
    expect(m.get("memo").multiline).toBe(true);
    expect(m.get("agree").kind).toBe("check");
    expect(m.get("grade").kind).toBe("radio");
    expect(m.get("grade").widgets.map((w: any) => w.onState)).toEqual(["A", "B", "C"]);
    expect(m.get("dept").kind).toBe("combo");
    expect(m.get("dept").options).toContain("Finance");
    expect(m.get("topics").kind).toBe("list");
    expect(m.get("name").widgets[0].page).toBe(1); // the form is on the second page
    expect(m.get("name").widgets[0].rect).toEqual([220, 669.92, 470, 691.92]);
  });

  it("reads the values Acrobat filled in", async () => {
    const m = byName(formFields(await openSurgeonDoc(load("acro_forms_rich_filled.pdf"))).fields);
    expect(m.get("name").value).toContain("Omni Test");
    expect(m.get("agree").value).toBe(true);
    expect(m.get("grade").value).toBe("B");
    expect(m.get("topics").value).toHaveLength(2);
  });

  it("fills every kind of field as an incremental update", async () => {
    const bytes = load("acro_forms_rich.pdf");
    const doc = await openSurgeonDoc(bytes);
    const m0 = byName(formFields(doc).fields);
    const topics = m0.get("topics").options.slice(0, 2);
    const values = { name: "오메 QA 채움 Omni", memo: "첫 줄 First line\n둘째 줄", agree: true, grade: "C", dept: "Finance", topics };
    const { bytes: out, report } = await fillForm(doc, values, { fallbackFont });
    expect(report.changed).toBe(true);
    expect(report.filled.sort()).toEqual(Object.keys(values).sort());
    expect(report.skipped).toEqual([]);
    expect(Buffer.from(out.subarray(0, bytes.length)).equals(Buffer.from(bytes))).toBe(true);

    expect(report.fallbackChars.length).toBeGreaterThan(0);
    expect(await embeddedGlyphsIntact(out)).toBeGreaterThan(0);
    const m = byName(formFields(await openSurgeonDoc(out)).fields);
    for (const [k, v] of Object.entries(values)) expect(m.get(k).value, k).toEqual(v);

    // pdf.js sees the same values and an appearance for each widget
    const js = await openJs(out);
    const annots = await (await js.getPage(m0.get("name").widgets[0].page + 1)).getAnnotations();
    const w = new Map(annots.filter((a: any) => a.fieldName).map((a: any) => [a.fieldName + (a.buttonValue ?? a.exportValue ? ":" + (a.buttonValue ?? a.exportValue) : ""), a]));
    expect((w.get("name") as any).fieldValue).toBe(values.name);
    expect([(w.get("dept") as any).fieldValue].flat()).toContain("Finance");
    expect((w.get("grade:C") as any).fieldValue).toBe("C");
    expect((w.get("agree:Yes") as any).fieldValue).toBe("Yes");
    for (const a of annots.filter((x: any) => ["name", "memo", "dept", "topics"].includes(x.fieldName))) expect(a.hasAppearance, a.fieldName).toBe(true);
  });

  it("changes nothing when the values are the same, and reports unknown or impossible values", async () => {
    const bytes = load("acro_forms_rich_filled.pdf");
    const doc = await openSurgeonDoc(bytes);
    const m = byName(formFields(doc).fields);
    const same = await fillForm(doc, { name: m.get("name").value, grade: "B" }, { fallbackFont });
    expect(same.report.changed).toBe(false);
    expect(same.bytes).toBe(doc.original);
    const bad = await fillForm(doc, { nope: "x", grade: "Z", dept: "없는 부서" }, { fallbackFont });
    expect(bad.report.changed).toBe(false);
    expect(bad.report.skipped).toHaveLength(3);
  });
});
