// .omw for older versions (io/omwLegacy.ts): body flow in columns written held so 0.2.0 / 0.2.1 do not re-flow it out
// of order (QA 11-23, rel-0.2.2-xver), and the features a file uses written so a version can say what it does not know.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { decode } from "cbor-x";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeOrder, reflowPages } from "../src/core/flow";
import type { OmwDocument, Page, TextNode } from "../src/core/types";
import { formatForExt } from "../src/io/formats";
import { packOmw, unpackOmw } from "../src/io/omw";
import { columnsLostAt, featuresOf, unknownContent } from "../src/io/omwLegacy";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

async function sample(): Promise<OmwDocument> {
  const bytes = new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx"));
  const r: any = await formatForExt("docx")!.open({ name: "omni-legacy.docx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-legacy", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(nodeOrder);
const bodyText = (pages: Page[]) => pages.flatMap(frames).flatMap((f) => f.paragraphs.map((q) => q.runs.map((r) => r.text).join(""))).join("\n");
const twoCols = (doc: OmwDocument): OmwDocument => ({ ...doc, pages: reflowPages(doc.pages.map((p) => ({ ...p, columns: { n: 2, gap: 48, line: true } }))) });
/** the package's manifest and stored scene graph */
function stored(bytes: Uint8Array) {
  const f = unzipSync(bytes);
  return { manifest: JSON.parse(strFromU8(f["manifest.json"])), graph: decode(f["scene_graph2.cbor"] ?? f["scene_graph.cbor"]), files: f };
}
/** the package with its manifest changed (an older version writes its own, without `features`) */
function withManifest(bytes: Uint8Array, edit: (m: any) => void): Uint8Array {
  const f = unzipSync(bytes);
  const m = JSON.parse(strFromU8(f["manifest.json"]));
  edit(m);
  f["manifest.json"] = strToU8(JSON.stringify(m));
  return zipSync(f);
}

describe(".omw for older versions", () => {
  it("columns: the flow is stored held (no `flow` for 0.2.0 / 0.2.1 to re-flow by position), read back as it was", async () => {
    const doc = twoCols(await sample());
    expect(doc.pages[0].nodes.some((n) => n.flowCol === 1)).toBe(true);
    const bytes = packOmw(doc).bytes;
    const { manifest, graph } = stored(bytes);
    const nodes = graph.pages.flatMap((p: any) => p.nodes);
    expect(nodes.some((n: any) => n.flow === true)).toBe(false);
    expect(nodes.filter((n: any) => n.flowHeld).length).toBe(doc.pages.flatMap((p) => p.nodes.filter((n) => n.flow)).length);
    // (the column rule and the flow columns stay in the file: an older version keeps them where they are)
    expect(nodes.some((n: any) => n.flowCol === 1)).toBe(true);
    expect(nodes.some((n: any) => String(n.id).includes(":colsep"))).toBe(true);
    expect(manifest.features).toEqual(expect.arrayContaining(["columns", "flowCol", "flowHeld"]));
    const r = unpackOmw(bytes);
    expect(r.report.rootMatches).toBe(true);
    expect(r.report.columnsHeld).toBe(true);
    expect(r.report.relayout).toBe(false);
    expect(r.report.unknown).toEqual([]);
    expect(bodyText(r.doc.pages)).toBe(bodyText(doc.pages));
    r.doc.pages.forEach((p, i) => expect(p.nodes.map((n) => [n.id, n.flow, n.flowCol, n.flowHeld])).toEqual(doc.pages[i].nodes.map((n) => [n.id, n.flow, n.flowCol, undefined])));
    // saved again: the same package content
    expect(stored(packOmw(r.doc).bytes).manifest.root).toBe(manifest.root);
  });

  it("a document without columns is written as before (no held flow, no features)", async () => {
    const doc = await sample();
    const { manifest, graph } = stored(packOmw(doc).bytes);
    expect(graph.pages.flatMap((p: any) => p.nodes).some((n: any) => n.flow === true)).toBe(true);
    expect(manifest.features).toBeUndefined();
    expect(featuresOf(doc)).toEqual([]);
  });

  it("held columns an older version saved (its manifest has no features) are laid out again on opening", async () => {
    const bytes = withManifest(packOmw(twoCols(await sample())).bytes, (m) => delete m.features);
    expect(unpackOmw(bytes).report.relayout).toBe(true);
  });

  it("columns an older version already re-flowed into one (no flowCol) are found", async () => {
    const doc = twoCols(await sample());
    const lost = doc.pages.map((p) => ({ ...p, nodes: p.nodes.map((n) => ({ ...n, flowCol: undefined })) }));
    // (as 0.2.1 lays them out: every frame the body's full width)
    expect(columnsLostAt(reflowPages(lost.map((p) => ({ ...p, columns: undefined }))).map((p, i) => ({ ...p, columns: doc.pages[i].columns })))).toEqual([0, 1, 2, 3]);
    expect(columnsLostAt(doc.pages)).toEqual([]);
  });

  it("a feature, document field or graph version this version does not know is reported (the 'made with a newer version' notice)", async () => {
    const doc = await sample();
    const bytes = withManifest(packOmw(doc).bytes, (m) => (m.features = ["columns", "omniFutureThing"]));
    expect(unpackOmw(bytes).report.unknown).toEqual(["omniFutureThing"]);
    expect(unknownContent(undefined, doc, true)).toEqual(["version"]);
    expect(unknownContent(["columns"], { ...doc, laterField: 1 } as any, false)).toEqual(["laterField"]);
  });
});
