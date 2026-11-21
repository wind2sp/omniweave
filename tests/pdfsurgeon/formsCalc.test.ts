// Acrobat's simple calculations after filling (Acrobat check 2026-11-18: a total stayed 0 after Omniweave filled qty and
// price, because Acrobat recalculates only when a field changes inside Acrobat) and the number formats it draws.
// Reference: qa/interop/adobe-made/pdf-fidelity/omni-pdf-base-forms.pdf (Acrobat 26: total = AFSimple_Calculate("PRD",
// qty, price), AFNumber_Format(2, …) on price and total; Acrobat itself filled 3 × 12.5 → V 37.5, shown 37.50).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillForm, formFields, openSurgeonDoc } from "../../src/io/pdfsurgeon";
import { formatDisplay, formatValue, simpleCalculation } from "../../src/io/pdfsurgeon/forms";
import { PDFDocument, PDFName, PDFString } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { ROOT, fallbackFont, openJs } from "./helpers";

describe("AFSimple_Calculate / AFNumber_Format", () => {
  it("reads the operation and the field names Acrobat writes", () => {
    expect(simpleCalculation('AFSimple_Calculate("PRD", new Array ("qty", "price"));')).toEqual({ op: "PRD", names: ["qty", "price"] });
    expect(simpleCalculation("AFSimple_Calculate('SUM', ['a.0', 'b'])")).toEqual({ op: "SUM", names: ["a.0", "b"] });
    expect(simpleCalculation("event.value = 1;")).toBeNull();
  });
  it("formats numbers like Acrobat's AFNumber_Format and AFPercent_Format", () => {
    const f = (dec: number, sep: number, neg = 0, cur = "", pre = true) => `AFNumber_Format(${dec}, ${sep}, ${neg}, 0, "${cur}", ${pre});`;
    expect(formatValue(f(2, 0), "37.5")).toBe("37.50");
    expect(formatValue(f(2, 0), "1234567.891")).toBe("1,234,567.89");
    expect(formatValue(f(0, 1), "1234.5")).toBe("1235");
    expect(formatValue(f(2, 2), "1234.5")).toBe("1.234,50");
    expect(formatValue(f(2, 0, 0, "$"), "-5")).toBe("-$5.00");
    expect(formatValue(f(2, 0, 2, "€", false), "-5")).toBe("(5.00€)");
    expect(formatValue("AFPercent_Format(1, 0);", "0.125")).toBe("12.5%");
    expect(formatValue(f(2, 0), "abc")).toBe("abc");
    expect(formatValue("", "3")).toBe("3");
  });
});

const ref = join(ROOT, "qa/interop/adobe-made/pdf-fidelity/omni-pdf-base-forms.pdf");
describe.skipIf(!existsSync(ref))("filling an Acrobat form with a calculated total", () => {
  it("writes the product into the total and draws price and total formatted", async () => {
    const doc = await openSurgeonDoc(new Uint8Array(readFileSync(ref)));
    const { bytes, report } = await fillForm(doc, { qty: "4", price: "2.5" }, { fallbackFont });
    expect(report.calculated).toEqual(["total"]);
    const fields = new Map(formFields(await openSurgeonDoc(bytes)).fields.map((f) => [f.name, f.value]));
    expect(fields.get("total")).toBe("10");
    const js = await openJs(bytes);
    const anns = await (await js.getPage(2)).getAnnotations();
    const shown = (name: string) => anns.find((a: any) => a.fieldName === name);
    expect(shown("total")?.fieldValue).toBe("10");
    const again = await fillForm(await openSurgeonDoc(bytes), { qty: "4" }, { fallbackFont });
    expect(again.report.changed).toBe(false);
  });
  it("a fill that does not touch the inputs leaves the total as it was", async () => {
    const doc = await openSurgeonDoc(new Uint8Array(readFileSync(ref)));
    const { report } = await fillForm(doc, { name: "오메" }, { fallbackFont });
    expect(report.calculated).toEqual([]);
  });
});

// QA 2026-11-18: Acrobat 26 filled a scratch form (sepStyle 0-4, negStyle 0-3, "€ " currency, a MAX over two totals
// that come later in /CO, a hidden and a read-only total) and its saved values and appearance texts were compared with ours
describe("Acrobat 26 cross-check of formats and calculation order", () => {
  it("sepStyle 4, red negative styles and JS escapes in the currency string", () => {
    const f = (dec: number, sep: number, neg: number, cur: string, pre: boolean) => `AFNumber_Format(${dec}, ${sep}, ${neg}, 0, "${cur}", ${pre});`;
    expect(formatValue(f(3, 4, 0, "", true), "308.125")).toBe("308.125");
    expect(formatValue(f(0, 4, 0, "", true), "1234567")).toBe("1'234'567");
    expect(formatValue(f(2, 0, 0, "\\u20AC ", false), "1262.5")).toBe("1,262.50€ ");
    expect(formatDisplay(f(2, 0, 1, "$", true), "-1234.5")).toEqual({ text: "$1,234.50", red: true });
    expect(formatDisplay(f(2, 0, 2, "$", true), "-1234.5")).toEqual({ text: "($1,234.50)", red: false });
    expect(formatDisplay(f(2, 3, 3, " kr", false), "-1234.5")).toEqual({ text: "(1234,50 kr)", red: true });
    expect(formatDisplay(f(2, 0, 1, "", true), "5")).toEqual({ text: "5.00", red: false });
    expect(formatValue("AFPercent_Format(0, 2);", "-1234.5")).toBe("-123.450%");
  });

  async function calcForm(calcs: [string, string][], inputs: string[], co: string[]) {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 600]);
    const form = pdf.getForm();
    let y = 560;
    const refs = new Map<string, any>();
    for (const n of [...inputs, ...calcs.map((c) => c[0])]) {
      const tf = form.createTextField(n);
      tf.addToPage(page, { x: 20, y, width: 200, height: 18 });
      y -= 22;
      refs.set(n, tf.ref);
    }
    for (const [n, js] of calcs) {
      const ctx = pdf.context;
      const fmt = ctx.obj({ S: "JavaScript", JS: PDFString.of('AFNumber_Format(2, 0, 1, 0, "", true);') });
      const c = ctx.obj({ S: "JavaScript", JS: PDFString.of(js) });
      form.getTextField(n).acroField.dict.set(PDFName.of("AA"), ctx.obj({ C: c, F: fmt }));
    }
    form.acroForm.dict.set(PDFName.of("CO"), pdf.context.obj(co.map((n) => refs.get(n))));
    return new Uint8Array(await pdf.save());
  }

  it("a total that depends on totals later in /CO gets their new values (Acrobat recalculates after every change)", async () => {
    const bytes = await calcForm(
      [["max", 'AFSimple_Calculate("MAX", new Array ("sum", "prd"));'], ["sum", 'AFSimple_Calculate("SUM", new Array ("a", "b"));'], ["prd", 'AFSimple_Calculate("PRD", new Array ("a", "b"));']],
      ["a", "b"],
      ["max", "sum", "prd"],
    );
    const { bytes: out, report } = await fillForm(await openSurgeonDoc(bytes), { a: "1234.5", b: "-2" }, { fallbackFont });
    const v = new Map(formFields(await openSurgeonDoc(out)).fields.map((f) => [f.name, f.value]));
    expect([v.get("sum"), v.get("prd"), v.get("max")]).toEqual(["1232.5", "-2469", "1232.5"]);
    expect(report.calculated.sort()).toEqual(["max", "prd", "sum"]);
    // the negative product is drawn red without a sign (negStyle 1)
    const d = await PDFDocument.load(out);
    const ap = d.getForm().getTextField("prd").acroField.getWidgets()[0].getNormalAppearance() as any;
    const s = inflateSync(Buffer.from(d.context.lookup(ap).contents)).toString("latin1");
    expect(s).toContain("1 0 0 rg");
  });

  it("circular references end (bounded passes) instead of looping", async () => {
    const bytes = await calcForm(
      [["x", 'AFSimple_Calculate("SUM", new Array ("y", "a"));'], ["y", 'AFSimple_Calculate("SUM", new Array ("x"));']],
      ["a"],
      ["x", "y"],
    );
    const { report } = await fillForm(await openSurgeonDoc(bytes), { a: "1" }, { fallbackFont });
    expect(report.calculated.sort()).toEqual(["x", "y"]);
  });
});
