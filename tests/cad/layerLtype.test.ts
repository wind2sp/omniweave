// Drawing page layer manager follow-ups (ui/cad/layers.ts): a layer linetype change re-dashes the entities drawn
// ByLayer from the drawing's LTYPE table (only loaded linetypes are offered), the vector PDF draws the new dashes,
// undo brings the old ones back; unnamed (*A) groups behind the "이름 없는 그룹 표시" toggle; rename + undo keeps
// the current layer.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PDFDocument, PDFArray, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type OmwDocument, type Page, type VectorNode } from "../../src/core/types";
import { exportPdfVector } from "../../src/io/pdfVector";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { cancel, currentLayer } from "../../src/ui/cad/engine";
import { cadLayers, cadPanelModel, loadedLtypes, ltypeDash, makeCurrent, renameLayer, setLayerLtype } from "../../src/ui/cad/layers";

const S = () => useStore.getState();
const pg = () => currentPage()! as Page;
const group = (name: string) => cadLayers(pg()).find((g) => g.cad!.layer === name)!;
/** vectors drawn ByLayer on a layer */
const byLayerOn = (name: string) => pg().nodes.filter((n): n is VectorNode => n.type === "VECTOR" && !!n.cadLt && !n.cadLayer && n.groupId === group(name).id);

async function pdfDashOps(): Promise<number> {
  const doc = { ...newDocument(), pages: [pg()], assets: S().doc.assets } as OmwDocument;
  const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
  const bytes = await exportPdfVector(doc, [pg()], { fonts });
  const pdf = await PDFDocument.load(bytes);
  let text = "";
  for (const p of pdf.getPages()) {
    const c = p.node.Contents();
    const streams = c instanceof PDFArray ? c.asArray().map((r) => pdf.context.lookup(r)) : [c];
    for (const s of streams) if (s instanceof PDFRawStream) text += new TextDecoder("latin1").decode(decodePDFRawStream(s).decode());
  }
  return (text.match(/\][^\n\]]*? d\b/g) ?? []).length;
}

describe("drawing layer linetype and groups", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(async () => {
    S().load(newDocument());
    resetSessionsForTest();
    cancel(true);
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    await openInTab({ name: "omni-cad-basic.dxf", path: null, bytes });
    S().set({ selection: [] });
  });

  it("offers only the linetypes loaded in the drawing", () => {
    const tab = pg().source!.cad!.ltypes!;
    expect(tab.DASHED?.pattern.length).toBeGreaterThan(0);
    const offered = loadedLtypes(pg());
    expect(offered[0]).toBe("Continuous");
    for (const x of offered.slice(1)) expect(tab[x.toUpperCase()], x).toBeTruthy();
    expect(offered.length).toBe(1 + Object.keys(tab).filter((k) => k !== "CONTINUOUS").length);
  });

  it("re-dashes ByLayer entities, reaches the PDF and undoes", async () => {
    // a solid layer with ByLayer entities
    const L = cadLayers(pg()).find((g) => (g.cad!.ltype ?? "").toUpperCase() === "CONTINUOUS" && byLayerOn(g.cad!.layer!).length > 0)!;
    expect(L).toBeTruthy();
    const name = L.cad!.layer!;
    const before = byLayerOn(name).map((n) => n.strokeDash);
    expect(before.every((d) => !d)).toBe(true);
    const pdf0 = await pdfDashOps();

    setLayerLtype(pg(), L.id, "DASHED");
    const after = byLayerOn(name);
    const dashed = after.filter((n) => n.strokeDash?.length);
    expect(dashed.length).toBeGreaterThan(0);
    for (const n of after) expect(n.strokeDash).toEqual(ltypeDash(pg(), "DASHED", n.cadLt!));
    // a single piece (a line) is laid out over its whole length, starting and ending with a dash
    const one = dashed.find((n) => n.cadLt!.segs?.length === 1);
    if (one) {
      const total = one.strokeDash!.reduce((a, v) => a + v, 0);
      expect(Math.abs(total - one.cadLt!.segs![0]!)).toBeLessThan(1e-6 * Math.max(1, total) + 1e-6);
    }
    expect(group(name).cad!.ltype).toBe("DASHED");
    // the vector PDF draws dashes for them
    const pdf1 = await pdfDashOps();
    expect(pdf1).toBeGreaterThan(pdf0);

    // a different loaded pattern changes the dashes again; Continuous makes them solid
    setLayerLtype(pg(), L.id, "Continuous");
    expect(byLayerOn(name).every((n) => !n.strokeDash)).toBe(true);
    S().undo();
    expect(byLayerOn(name).filter((n) => n.strokeDash?.length).length).toBe(dashed.length);
    S().undo();
    expect(byLayerOn(name).map((n) => n.strokeDash)).toEqual(before);
    expect((group(name).cad!.ltype ?? "").toUpperCase()).toBe("CONTINUOUS");
    expect(await pdfDashOps()).toBe(pdf0);
  });

  it("hides unnamed groups unless asked, with the toggle text in four languages", () => {
    const ids = pg().nodes.slice(0, 2).map((n) => n.id);
    S().commit("g", (d) => {
      const p = d.pages.find((x) => x.id === pg().id)!;
      p.source!.cad!.groups = [
        { name: "OMNI-G1", ids },
        { name: "*A1", ids: [ids[0]!], unnamed: true },
      ];
    });
    const names = (o?: { unnamed?: boolean }) => cadPanelModel(pg(), o).flatMap((r) => (r.kind === "group" ? [r.name] : []));
    expect(names()).toEqual(["OMNI-G1"]);
    expect(names({ unnamed: true })).toEqual(["OMNI-G1", "*A1"]);
    const txt = (l: string) => JSON.parse(readFileSync(`src/i18n/parts/cadlm/${l}.json`, "utf8"))["cadlm.unnamedGroups"] as string;
    expect(txt("ko")).toBe("이름 없는 그룹 표시");
    expect(txt("en")).toBeTruthy();
    // ja full-width brackets; zh keeps the house style (half-width around ASCII, tests/i18nGrammar.test.ts)
    expect(txt("ja")).toMatch(/（\*A）/);
    expect(txt("zh")).toMatch(/\(\*A\)/);
  });

  it("rename + undo keeps the current layer", () => {
    const L = cadLayers(pg()).find((g) => g.cad!.layer !== "0" && g.cad!.layer!.toUpperCase() !== "DEFPOINTS" && !g.cad!.frozen)!;
    const was = L.cad!.layer!;
    expect(makeCurrent(pg(), L.id)).toBeNull();
    expect(currentLayer(pg())).toBe(was);
    expect(renameLayer(pg(), L.id, "omni-renamed")).toBeNull();
    expect(currentLayer(pg())).toBe("omni-renamed");
    S().undo();
    expect(currentLayer(pg())).toBe(was);
    S().redo();
    expect(currentLayer(pg())).toBe("omni-renamed");
  });
});
