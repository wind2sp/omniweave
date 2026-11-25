// 2026-11-24 (design 2): a live appearance given to an opened .ai's own path (live corners, a live effect) is written
// when the .ai is saved in its own format — the plain paths it draws go in where the original was drawn (its place in
// the stacking order), gradient-filled shapes included.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { SceneNode, VectorNode } from "../src/core/types";

const width = (n: VectorNode) => {
  const xs = n.contours.flatMap((c) => c.nodes.map((a) => a.anchor[0] * n.transform.scale + n.transform.x));
  return Math.max(...xs) - Math.min(...xs);
};
const anchors = (n: VectorNode) => n.contours.reduce((k, c) => k + c.nodes.length, 0);

async function open() {
  const sg = await import("../src/io/pdfsurgeon");
  const doc = await sg.openSurgeonDoc(new Uint8Array(readFileSync("qa/interop/adobe-made/ai_layers.ai")));
  const nodes = structuredClone(sg.elevatePage(doc, 0, { prefix: "omw", vectors: "auto" }).nodes) as SceneNode[];
  const save = async () => {
    const { bytes } = await sg.saveSurgical(doc, [{ pageIndex: 0, nodes, elevated: true }], { prefix: "omw", vectors: "auto" });
    return sg.elevatePage(await sg.openSurgeonDoc(bytes), 0, { prefix: "omw", vectors: true }).nodes.filter((n): n is VectorNode => n.type === "VECTOR");
  };
  return { nodes, save };
}

describe("live appearance saved into the .ai", () => {
  it("an Offset Path effect on the star is in the saved file, in the star's place in the stack", async () => {
    const { nodes, save } = await open();
    const vs = nodes.filter((n): n is VectorNode => n.type === "VECTOR" && !!n.fill && !(n as { fills?: unknown[] }).fills?.length);
    const star = [...vs].sort((a, b) => anchors(b) - anchors(a))[0];
    const w0 = width(star);
    star.vfx = [{ kind: "offset", on: true, d: 10, join: "miter" }];
    const again = await save();
    const i = again.findIndex((w) => width(w) > w0 + 10);
    expect(i).toBeGreaterThanOrEqual(0);
    // not appended on top: something of the file is still drawn above it
    expect(i).toBeLessThan(again.length - 1);
  });

  it("live corners on the gradient-filled band keep its gradient", async () => {
    const { nodes, save } = await open();
    const band = nodes.find((n): n is VectorNode => n.type === "VECTOR" && (n as { fills?: { type: string }[] }).fills?.[0]?.type === "gradient")!;
    expect(band).toBeTruthy();
    band.cornerRadius = 20;
    const again = await save();
    const g = again.filter((n) => (n as { fills?: { type: string }[] }).fills?.[0]?.type === "gradient");
    expect(g.length).toBeGreaterThan(0);
    // the rounded band: its corners are fillets now (more anchors than the 4 of a rectangle)
    expect(g.some((n) => anchors(n) >= 8)).toBe(true);
  });
});
