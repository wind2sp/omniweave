// 참조 › 목차 (ui/docExtrasUi.ts): the headings 1–3 of the body with the page numbers they show (QA ui-audit #26).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, expect, it } from "vitest";
import { formatForExt } from "../src/io/formats";
import { tocEntries } from "../src/ui/docExtrasUi";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

it("omni-sample.docx: headings in order, levels 1–3, roman numbers in the front section as its footer shows", async () => {
  const r: any = await formatForExt("docx")!.open({ name: "omni-sample.docx", path: null, bytes: new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx")) }, {} as any);
  const e = tocEntries({ pages: r.pages });
  expect(e.length).toBeGreaterThanOrEqual(8);
  expect(e[0]).toMatchObject({ level: 1, page: "i" });
  expect(e[0].text).toContain("요약");
  expect(e.every((x) => x.level >= 1 && x.level <= 3 && x.text)).toBe(true);
  expect(e.some((x) => x.text.includes("부록") && /^\d+$/.test(x.page))).toBe(true);
});
