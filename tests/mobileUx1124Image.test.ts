// Phone check 2026-11-24 (mobile-review/ux-audit.md), the image items:
//  #4  a photo turned 90° kept its canvas, so both ends were cut off (and the JPG too);
//  #5  a plain SVG failed on the phone with "opens only as a picture" (the registry handed back a picture to place);
//  #13 a photo fixed in the PC screen saved as .omw without a word; 밝기 · 명도 · 조정 found no command;
//      AI shapes could not be picked one by one (clip paths came in as open contours, outside the fill hit test).
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newImage, newPage, newVector, type Page } from "../src/core/types";
import { corner, pointInContours } from "../src/core/vector";
import { formatForExt } from "../src/io/formats";
import { saveTargetFor } from "../src/ui/actions";
import { allCommands, command, commandLabel } from "../src/ui/commands";
import { matchCommands } from "../src/ui/shell/ShellDialogs";

const S = () => useStore.getState();

beforeAll(() => {
  (globalThis as any).DOMParser ??= DOMParser;
});

function photo(): Page {
  const doc = newDocument();
  const p = newPage("DESIGN", 1200, 600, "omni-landscape");
  const img = newImage("a_omni", 1200, 600, "omni-landscape.jpg");
  img.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  p.nodes.push(img);
  p.source = { format: "jpg", name: "omni-landscape.jpg" };
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: [], mode: "AUTO" });
  return p;
}

describe("#4 a photo turned 90° turns its canvas", () => {
  it("'오른쪽으로 90° 회전' with nothing chosen in the image mode turns the canvas (1200 × 600 → 600 × 1200)", () => {
    photo();
    command("object.rotateCW")!.run();
    const p = S().doc.pages[0];
    expect([p.width, p.height]).toEqual([600, 1200]);
    expect(p.nodes[0].transform.rotation).toBe(90);
  });
  it("the canvas commands are found by name and are in the image menu's rotation", () => {
    photo();
    const ids = matchCommands(allCommands(), "회전").map((c) => c.id);
    expect(ids).toContain("image.rotateCanvasCW");
    expect(commandLabel(command("image.rotateCanvasCW")!)).toBe("캔버스 오른쪽으로 90° 회전");
    command("image.rotateCanvasCCW")!.run();
    expect([S().doc.pages[0].width, S().doc.pages[0].height]).toEqual([600, 1200]);
  });
  it("a chosen layer still turns alone", () => {
    const p = photo();
    S().set({ selection: [p.nodes[0].id] });
    command("object.rotateCW")!.run();
    expect([S().doc.pages[0].width, S().doc.pages[0].height]).toEqual([1200, 600]);
  });
});

describe("#5 a plain SVG opens as editable artwork from the format registry (the phone's way in)", () => {
  it("layers, shapes and text come back as a page, not a picture to place", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><g id="배경"><rect width="400" height="300" fill="#f4f6fb"/><circle cx="120" cy="150" r="70" fill="#3b82f6"/></g><g id="글자"><rect x="220" y="90" width="140" height="120" fill="#f97316"/><text x="230" y="250" font-size="24">오메 SVG</text></g></svg>`;
    const r = await formatForExt("svg")!.open!({ name: "omni-layers.svg", path: null, bytes: new TextEncoder().encode(svg) }, { confirm: () => false });
    expect(r.place).toBeUndefined();
    const page = r.pages![0];
    expect(page.source?.format).toBe("svg");
    expect(page.nodes.map((n) => n.type)).toEqual(["VECTOR", "VECTOR", "VECTOR", "TEXT"]);
    expect(page.groups?.map((g) => g.name)).toEqual(["배경", "글자"]);
  });
});

describe("#13 saving a photo, finding adjustments, picking AI shapes", () => {
  it("저장 keeps a picture's or PSD's own format", () => {
    for (const f of ["jpg", "png", "webp", "psd"]) expect(saveTargetFor(f)).toBe("same");
  });
  it("밝기 · 명도 · 조정 find the adjustments (Korean and English)", () => {
    photo();
    const first = (q: string) => matchCommands(allCommands(), q).map((c) => c.id);
    expect(first("밝기")[0]).toBe("imageop.brightnessContrast");
    expect(first("밝기")).toContain("imageop.levels");
    expect(first("명도")).toContain("imageop.brightnessContrast");
    expect(first("조정")).toContain("imageop.curves");
    expect(commandLabel(command("imageop.brightnessContrast") ?? allCommands().find((c) => c.id === "imageop.brightnessContrast")!)).toBe("조정 ▸ 명도/대비…");
  });
  it("a filled open contour (an Illustrator clip path, a PDF fill without h) is hit inside its area", () => {
    const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(100, 0), corner(100, 100), corner(0, 100)] }], "omni-open");
    v.fill = "#3366ff";
    expect(pointInContours(v, [50, 50])).toBe(true);
    expect(pointInContours(v, [150, 50])).toBe(false);
    // a two-point open line has no inside
    const line = newVector([{ closed: false, nodes: [corner(0, 0), corner(100, 0)] }], "omni-line");
    line.fill = "#000000";
    expect(pointInContours(line, [50, 0])).toBe(false);
  });
});
