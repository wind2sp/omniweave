// An unedited PSD page is drawn (thumbnails, PNG / PDF export, slide show) as Photoshop's merged image —
// core/fidelity/overlay.ts pristinePsdView — and falls back to our compositing the moment anything changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { pristinePsdView } from "../../src/core/fidelity/overlay";
import type { Page, RasterNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
function open(name: string): Page {
  const bytes = new Uint8Array(readFileSync(join(DIR, name + ".psd")));
  return importPsdPage(bytes, name + ".psd", name, makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd")).page;
}

describe("pristine PSD view", () => {
  const page = open("omni-fid-adj-group");
  const comp = page.source!.psd!.compositeNode!;

  it("an unedited page shows only Photoshop's merged image (visible), layers kept in the document", () => {
    const v = pristinePsdView(page)!;
    expect(v).not.toBeNull();
    expect(v.nodes).toHaveLength(1);
    expect(v.nodes[0].id).toBe(comp);
    expect(v.nodes[0].visible).toBe(true);
    expect(v.groups).toBeUndefined();
    expect(page.nodes.length).toBeGreaterThan(1);
    expect(page.nodes.find((n) => n.id === comp)!.visible).toBe(false);
  });

  it("names, locks and folder collapse do not count as edits", () => {
    const p = produce(page, (d) => {
      d.nodes[0].name = "renamed";
      d.nodes[0].locked = !d.nodes[0].locked;
      for (const g of d.groups ?? []) g.collapsed = !g.collapsed;
    });
    expect(pristinePsdView(p)).not.toBeNull();
  });

  const edits: [string, (d: Page) => void][] = [
    ["layer opacity", (d) => void ((d.nodes.find((n) => n.name === "Top") as RasterNode).opacity = 0.5)],
    ["layer hidden", (d) => void (d.nodes.find((n) => n.name === "Top")!.visible = false)],
    ["layer moved", (d) => void (d.nodes.find((n) => n.name === "Top")!.transform.x += 3)],
    ["layer effect added", (d) => void (d.nodes.find((n) => n.name === "Top")!.effects = [{ type: "dropShadow", on: true, color: { hex: "#000000" }, angle: 120, distance: { v: 5, u: "px" }, spread: 0, size: { v: 5, u: "px" } } as never])],
    ["layer blend", (d) => void (d.nodes.find((n) => n.name === "Top")!.blendMode = "SCREEN")],
    ["layer deleted", (d) => void d.nodes.splice(d.nodes.findIndex((n) => n.name === "Top"), 1)],
    ["order", (d) => void d.nodes.reverse()],
    ["folder opacity", (d) => void (d.groups![0].opacity = 0.5)],
    ["background", (d) => void (d.background = "#000000")],
    ["object added", (d) => void d.nodes.push({ ...JSON.parse(JSON.stringify(d.nodes.find((n) => n.name === "Top"))), id: "added-by-user" })],
    ["merged image shown as a layer", (d) => void (d.nodes.find((n) => n.id === comp)!.visible = true)],
  ];
  for (const [what, f] of edits) it(`any edit → our compositing: ${what}`, () => expect(pristinePsdView(produce(page, f))).toBeNull());

  it("documents from before the import signature never use it", () => {
    expect(pristinePsdView(produce(page, (d) => void delete d.source!.psd!.importSig))).toBeNull();
  });
});
