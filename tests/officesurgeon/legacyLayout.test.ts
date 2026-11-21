// QA doc-gaps-1: documents opened from DOCX / HWPX before page setup existed (.omw with a v1 block map; pages without
// margins / breakBefore) must save as before: unchanged → the original bytes, a new file → no page break at every
// automatic page boundary. And HWPX margins must survive a write → read → write without drifting by a unit.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { breakPageInPlace } from "../../src/core/pageSetup";
import { PAGE_PRESETS, type OmwDocument, type Page, type TextNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { exportDocx, exportHwpx, hwpxPagePrXml, hwpxSetup } from "../../src/io/office";
import { parseXml } from "../../src/io/xml";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const FILES = { docx: readFileSync("qa/interop/adobe-made/word_doc.docx"), hwpx: readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx") };

async function openLegacy(kind: "docx" | "hwpx"): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `legacy.${kind}`, path: null, bytes: FILES[kind] }, {} as any);
  // what the app before doc-gaps-1 stored: A4 pages with no margins / breakBefore, a block map of rules version 1
  const pages = r.pages.map((p: Page) => {
    const q = { ...p, width: PAGE_PRESETS.A4.width, height: PAGE_PRESETS.A4.height };
    delete q.margins;
    delete q.breakBefore;
    return q;
  });
  if (pages[0].source?.office) pages[0].source = { ...pages[0].source, office: { ...pages[0].source.office, engine: 1 } };
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (kind: "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;

describe("documents from before page setup (v1 block maps)", () => {
  it("HWPX opened and saved unchanged keeps the original bytes", async () => {
    const doc = await openLegacy("hwpx");
    expect(doc.pages.length).toBeGreaterThan(1);
    const msgs: string[] = [];
    expect(Buffer.from(await save("hwpx", doc, msgs)).equals(FILES.hwpx)).toBe(true);
    expect(msgs).toEqual([]);
  });

  it("a v1 map no longer valid (DOCX with a page break) or pages changed since: written anew after the notice, never patched", async () => {
    const docx = await openLegacy("docx");
    const m1: string[] = [];
    const out = await save("docx", docx, m1);
    expect(m1.length).toBe(1);
    expect(Buffer.from(out).equals(FILES.docx)).toBe(false);
    const hwpx = await openLegacy("hwpx");
    const i = hwpx.pages.findIndex((p) => p.nodes.some((n) => n.type === "TEXT" && (n as TextNode).paragraphs.length >= 2));
    const t = hwpx.pages[i].nodes.find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.length >= 2)!;
    breakPageInPlace(hwpx.pages, i, "page", { pageId: "pgN", nodeId: "nN", name: "n" }, { nodeId: t.id, keep: t.paragraphs.slice(0, 1), moved: t.paragraphs.slice(1) });
    const m2: string[] = [];
    const out2 = await save("hwpx", hwpx, m2);
    expect(m2.length).toBe(1);
    expect(strFromU8(unzipSync(out2)["Contents/section0.xml"]).match(/pageBreak="1"/g) ?? []).toHaveLength(1);
  });

  it("written anew: no page break at every automatic page boundary (as before)", async () => {
    for (const kind of ["docx", "hwpx"] as const) {
      const doc = await openLegacy(kind);
      expect(doc.pages.length).toBeGreaterThan(1);
      if (kind === "docx") {
        const xml = strFromU8(unzipSync(exportDocx(doc.pages))["word/document.xml"]);
        expect(xml.match(/w:type="page"/g) ?? []).toHaveLength(0);
      } else {
        const files = unzipSync(exportHwpx(doc.pages, "t"));
        expect(strFromU8(files["Contents/section0.xml"]).match(/pageBreak="1"/g) ?? []).toHaveLength(0);
      }
    }
  });

  it("a page break made in such a document is still written (and the old pages keep flowing)", async () => {
    const doc = await openLegacy("docx");
    const i = doc.pages.findIndex((p) => p.nodes.some((n) => n.type === "TEXT" && (n as TextNode).paragraphs.length >= 2));
    const t = doc.pages[i].nodes.find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.length >= 2)!;
    breakPageInPlace(doc.pages, i, "page", { pageId: "pgN", nodeId: "nN", name: "n" }, { nodeId: t.id, keep: t.paragraphs.slice(0, 1), moved: t.paragraphs.slice(1) });
    const xml = strFromU8(unzipSync(exportDocx(doc.pages))["word/document.xml"]);
    expect(xml.match(/w:type="page"/g) ?? []).toHaveLength(1);
  });
});

describe("HWPX page margins round trip", () => {
  it("한글's default margins are written back unit for unit", () => {
    const sec = parseXml('<hp:secPr xmlns:hp="x"><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr></hp:secPr>').documentElement;
    expect(hwpxPagePrXml(hwpxSetup(sec))).toContain('<hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/>');
  });
  it("odd HWPUNIT values survive", () => {
    for (const [top, header, bottom, footer] of [[5669, 4253, 4251, 4249], [1, 1, 3, 7], [2834, 2833, 1417, 1418]]) {
      const sec = parseXml(`<hp:secPr xmlns:hp="x"><hp:pagePr landscape="WIDELY" width="59528" height="84186"><hp:margin header="${header}" footer="${footer}" gutter="0" left="8504" right="8504" top="${top}" bottom="${bottom}"/></hp:pagePr></hp:secPr>`).documentElement;
      expect(hwpxPagePrXml(hwpxSetup(sec))).toContain(`header="${header}" footer="${footer}" gutter="0" left="8504" right="8504" top="${top}" bottom="${bottom}"`);
    }
  });
});
