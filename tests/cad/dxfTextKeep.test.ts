// Imported TEXT / MTEXT written back as they were (core/cadText.ts, dxfWrite2000.ts): open an AutoCAD DXF, change
// nothing, export — each text's insertion point (10/20), alignment point (11/21), justification (72/73) and height (40)
// are the original's (they came back off: height 2.5 → 2.5087, y −1.25 → −1.2609). A moved text keeps them, moved; an
// edited one is written from its nodes again.
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { newDocument, type TextNode } from "../../src/core/types";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { writeDxf2000 } from "../../src/io/formats/cad/dxfWrite2000";

const S = () => useStore.getState();
type Rec = { type: string; c: Record<number, string> };
/**
 * TEXT / MTEXT records with the codes compared, and where they are: model or paper space (ENTITIES with 67, or a
 * layout's *Paper_Space block), or a named block's definition (anonymous blocks — dimensions — left out)
 */
function texts(bytes: Uint8Array): Rec[] {
  const L = new TextDecoder("latin1").decode(bytes).split(/\r?\n/).map((x) => x.trim());
  const out: Rec[] = [];
  let sec = "", blk = "";
  for (let i = 0; i + 1 < L.length; i += 2) {
    if (L[i] === "2" && L[i - 1] === "SECTION") sec = L[i + 1];
    if (L[i] === "0" && L[i + 1] === "BLOCK")
      for (let j = i + 2; j + 1 < L.length; j += 2)
        if (L[j] === "2") {
          blk = L[j + 1].toUpperCase();
          break;
        }
    if (sec !== "ENTITIES" && sec !== "BLOCKS") continue;
    if (L[i] !== "0" || !/^M?TEXT$/.test(L[i + 1])) continue;
    const paperBlk = sec === "BLOCKS" && blk.startsWith("*PAPER_SPACE");
    if (sec === "BLOCKS" && blk.startsWith("*") && !paperBlk) continue;
    let paper = paperBlk;
    for (let j = i + 2; j + 1 < L.length && L[j] !== "0"; j += 2) if (L[j] === "67" && L[j + 1] === "1") paper = true;
    const r: Rec = { type: `${L[i + 1]}@${paper ? "paper" : sec === "BLOCKS" ? blk : "model"}`, c: {} };
    for (let j = i + 2; j + 1 < L.length && L[j] !== "0"; j += 2) {
      const c = +L[j];
      // (an MTEXT's embedded object (101, AutoCAD 2018) has 10 / 11 / 40 of its own: not the entity's)
      if (c === 101) break;
      if ([10, 20, 11, 21, 40, 72, 73, 71].includes(c) && r.c[c] === undefined) r.c[c] = L[j + 1];
    }
    out.push(r);
  }
  return out;
}
const num = (v?: string) => (v === undefined ? undefined : +v);
async function open(path: string) {
  S().load(newDocument());
  resetSessionsForTest();
  await openInTab({ name: path.split("/").pop()!, path: null, bytes: new Uint8Array(readFileSync(path)) });
}
// (omni-cad-blocktext-2018: made by AutoCAD 2027 for this test — TEXT / MTEXT in a block inserted twice, once 2× and
// turned 30°, and TEXT / MTEXT on a layout's paper; omni-cad-21-viewports: texts on the sheet of two layouts)
const SAMPLES = ["qa/samples/store-sample/ko/omni-store-drawing.dxf", "qa/interop/autocad-made/omni-cad-03-text-2018.dxf", "qa/interop/autocad-made/omni-cad-15-mtext-2018.dxf", "tests/fixtures/cad/omni-cad-blocktext-2018.dxf", "qa/interop/autocad-made/omni-cad-21-viewports-2018.dxf"].filter((p) => existsSync(p));

describe("DXF texts kept as read", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  for (const path of SAMPLES)
    it(`${path.split("/").pop()}: unchanged texts come back with the same points, justification and height`, async () => {
      await open(path);
      const src = texts(new Uint8Array(readFileSync(path)));
      const out = texts(writeDxf2000(currentPage()!, S().doc.pages).bytes);
      // every source text is there, same type, same codes (numbers compared exactly as numbers)
      for (const a of src) {
        const b = out.find((x) => x.type === a.type && num(x.c[10]) === num(a.c[10]) && num(x.c[20]) === num(a.c[20]));
        expect(b, `${a.type} at ${a.c[10]},${a.c[20]}`).toBeTruthy();
        for (const c of [11, 21, 40, 72, 73, 71]) expect(num(b!.c[c]), `${a.type} ${a.c[10]},${a.c[20]} code ${c}`).toBe(num(a.c[c]));
      }
      // and no more of them anywhere (a block's texts seen through a viewport came back as paper texts)
      const count = (rs: Rec[]) => rs.reduce<Record<string, number>>((o, r) => ((o[r.type] = (o[r.type] ?? 0) + 1), o), {});
      expect(count(out)).toEqual(count(src));
    });
  it("every LAYOUT has a paper size (AutoCAD: 'no plottable sheets' for a PDF of the export without one)", async () => {
    for (const path of SAMPLES.slice(3)) {
      await open(path);
      const L = new TextDecoder("latin1").decode(writeDxf2000(currentPage()!, S().doc.pages).bytes).split(/\r?\n/).map((x) => x.trim());
      const sizes: [number, number][] = [];
      for (let i = 0; i + 1 < L.length; i += 2)
        if (L[i] === "0" && L[i + 1] === "LAYOUT") {
          let w = 0, h = 0;
          for (let j = i + 2; j + 1 < L.length && L[j] !== "0"; j += 2) {
            if (L[j] === "44") w = +L[j + 1];
            if (L[j] === "45") h = +L[j + 1];
          }
          sizes.push([w, h]);
        }
      expect(sizes.length).toBeGreaterThanOrEqual(2);
      for (const [w, h] of sizes) expect(w > 0 && h > 0, `${path}: ${w}×${h}`).toBe(true);
    }
  });
  it("a moved text keeps its codes, moved; an edited one is written from its nodes", async () => {
    await open(SAMPLES[0]);
    const page = currentPage()!;
    const k = page.source!.cad!.k;
    const t = page.nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.cadText && n.paragraphs[0]?.runs[0]?.text.startsWith("L01"))!;
    const before = texts(writeDxf2000(page, S().doc.pages).bytes).find((x) => +x.c[10] === 145 && +x.c[20] === -1.25)!;
    expect(before).toBeTruthy();
    S().commit("move", (d) => {
      const n = d.pages[0].nodes.find((x) => x.id === t.id)!;
      n.transform.x += 5 * k;
    });
    const moved = texts(writeDxf2000(currentPage()!, S().doc.pages).bytes).find((x) => Math.abs(+x.c[10] - 150) < 1e-9 && +x.c[20] === -1.25);
    expect(moved, "moved by 5 drawing units").toBeTruthy();
    expect(+moved!.c[40]).toBe(2.5);
    S().commit("edit", (d) => {
      const n = d.pages[0].nodes.find((x) => x.id === t.id) as TextNode;
      n.paragraphs[0].runs[0].text = "OMW-EDITED";
    });
    const r = writeDxf2000(currentPage()!, S().doc.pages);
    expect(new TextDecoder("latin1").decode(r.bytes)).toContain("OMW-EDITED");
  });
});

// (OMW_TEXT_OUT=<folder>: the three unchanged exports written there, for AutoCAD's AUDIT)
describe.skipIf(!process.env.OMW_TEXT_OUT)("DXF texts kept as read — files for AutoCAD", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  it("writes omw-r2000-text-*.dxf", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(process.env.OMW_TEXT_OUT!, { recursive: true });
    for (const path of SAMPLES) {
      await open(path);
      writeFileSync(`${process.env.OMW_TEXT_OUT}/omw-r2000-text-${path.split("/").pop()!.replace(/\.dxf$/, "")}.dxf`, writeDxf2000(currentPage()!, S().doc.pages).bytes);
    }
  });
});
