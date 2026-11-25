// 개요 번호 on a heading of a 한글 file (QA 11-25 real use): written by Office Surgeon in place — an OUTLINE paragraph
// numbered by the section's outline numbering (the file's own when the 개요 번호 모양 is the same, else one made from
// the chosen definition and named by the sections) — instead of the whole file anew.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import * as RT from "../src/core/richtext";
import type { OmwDocument, Page, TextNode } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const SAMPLE = "qa/interop/hancom-made/omni-hwp-links.hwpx";
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt("hwpx")!.open({ name: "omni-outline.hwpx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-outline", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const frame = (p: Page) => p.nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.flow)!;
async function save(doc: OmwDocument) {
  let asked = 0;
  const bytes = (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => (asked++, false) } as any)) as Uint8Array;
  return { bytes, asked };
}
/** a heading "OMNIOUTLINE" added at the end, numbered with the outline definition `def` */
function withHeading(doc: OmwDocument, def: string): OmwDocument {
  const f = frame(doc.pages[0]);
  const last = f.paragraphs[f.paragraphs.length - 1];
  let ps = [...f.paragraphs, { ...last, id: "pOutline", runs: [{ ...last.runs[0], text: "OMNIOUTLINE" }] }];
  ps = RT.setHeading(ps, ps.length - 1, ps.length - 1, 1);
  ps = RT.applyOutline(ps, def).paras;
  return { ...doc, pages: doc.pages.map((p, i) => (i === 0 ? { ...p, nodes: p.nodes.map((n) => (n === f ? { ...f, paragraphs: ps } : n)) } : p)) };
}
const headingOf = (bytes: Uint8Array) => {
  const z = unzipSync(bytes);
  const sec = strFromU8(z["Contents/section0.xml"]), head = strFromU8(z["Contents/header.xml"]);
  const p = (sec.match(/<hp:p [\s\S]*?<\/hp:p>/g) ?? []).find((q) => q.includes("OMNIOUTLINE")) ?? "";
  const pp = /paraPrIDRef="(\d+)"/.exec(p)?.[1];
  const pr = head.slice(head.indexOf(`<hh:paraPr id="${pp}"`));
  return { heading: /<hh:heading [^>]*>/.exec(pr.slice(0, pr.indexOf("</hh:paraPr>")))?.[0] ?? "", sec, head };
};

describe("개요 번호 on a heading of a 한글 file", () => {
  it("한글's own 개요 번호 모양: in place, an OUTLINE paragraph, read back numbered", async () => {
    const doc = await open(new Uint8Array(readFileSync(SAMPLE)));
    const { bytes, asked } = await save(withHeading(doc, "outlineKo"));
    expect(asked).toBe(0);
    const h = headingOf(bytes);
    expect(h.heading).toMatch(/type="OUTLINE"[^>]*level="0"/);
    const back = await open(bytes);
    const q = frame(back.pages[0]).paragraphs.find((x) => x.runs.some((r) => r.text.includes("OMNIOUTLINE")))!;
    expect(q.role).toBe("h1");
    expect(q.list).toBeTruthy();
  });

  it("another 개요 번호 모양 (1. / 1.1.): in place, a numbering of it named by the section as its outline shape", async () => {
    const doc = await open(new Uint8Array(readFileSync(SAMPLE)));
    const { bytes, asked } = await save(withHeading(doc, "outline"));
    expect(asked).toBe(0);
    const h = headingOf(bytes);
    expect(h.heading).toMatch(/type="OUTLINE"/);
    const ref = /<hp:secPr\b[^>]*\soutlineShapeIDRef="(\d+)"/.exec(h.sec)?.[1];
    const num = h.head.slice(h.head.indexOf(`<hh:numbering id="${ref}"`));
    // level 2 of 1. / 1.1.: "^1.^2."
    expect(num.slice(0, num.indexOf("</hh:numbering>"))).toMatch(/level="2"[^>]*>\^1\.\^2\.</);
    const back = await open(bytes);
    const q = frame(back.pages[0]).paragraphs.find((x) => x.runs.some((r) => r.text.includes("OMNIOUTLINE")))!;
    expect(q.list).toBeTruthy();
  });
});
