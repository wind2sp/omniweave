// DOCX floating pictures measured from the margin strips (rightMargin, bottomMargin, inside / outside, leftMargin):
// officeDrawing.ts docxPicOf + picArea; a rotation change re-sizes wp:effectExtent (officesurgeon/pics.ts).
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { docxDrawingXml, docxPicOf, picArea, rotExtent, type PicGeom } from "../src/io/officeDrawing";
import { patchDocxDrawing } from "../src/io/officesurgeon/pics";

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function anchor(h: string, v: string): Element {
  const xml = `<w:drawing ${W}><wp:anchor simplePos="0" behindDoc="0"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${h.split(":")[0]}">${h.includes(":") ? `<wp:align>${h.split(":")[1]}</wp:align>` : "<wp:posOffset>0</wp:posOffset>"}</wp:positionH><wp:positionV relativeFrom="${v.split(":")[0]}">${v.includes(":") ? `<wp:align>${v.split(":")[1]}</wp:align>` : "<wp:posOffset>0</wp:posOffset>"}</wp:positionV><wp:extent cx="952500" cy="952500"/><wp:wrapNone/><wp:docPr id="1" name="p"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing>`;
  return new DOMParser().parseFromString(xml, "text/xml").documentElement as unknown as Element;
}

describe("floating picture places from the margin strips", () => {
  it("reads the strip each relativeFrom names", () => {
    expect(docxPicOf(anchor("rightMargin:center", "bottomMargin:top"))!.float).toMatchObject({ xFrom: "rightMargin", xAlign: "center", yFrom: "bottomMargin", yAlign: "top" });
    expect(docxPicOf(anchor("insideMargin", "topMargin"))!.float).toMatchObject({ xFrom: "leftMargin", yFrom: "topMargin" });
    expect(docxPicOf(anchor("outsideMargin:left", "page"))!.float).toMatchObject({ xFrom: "rightMargin" });
    expect(docxPicOf(anchor("column", "paragraph"))!.float).toMatchObject({ xFrom: "margin", yFrom: "para" });
  });
  it("areas: page, body, and each margin strip", () => {
    // A4 width 794, margins 96 left / 72 right
    expect(picArea("page", 794, 96, 72)).toEqual({ from: 0, size: 794 });
    expect(picArea("margin", 794, 96, 72)).toEqual({ from: 96, size: 626 });
    expect(picArea("leftMargin", 794, 96, 72)).toEqual({ from: 0, size: 96 });
    expect(picArea("rightMargin", 794, 96, 72)).toEqual({ from: 722, size: 72 });
  });
});

describe("rotation and wp:effectExtent", () => {
  const g: PicGeom = { x: 10, y: 10, w: 100, h: 50, rot: 0, flipH: false, flipV: false, crop: null };
  it("a picture turned in the app gets the room its turned box needs", () => {
    const d = docxDrawingXml({ rId: "rId5", id: 3, name: "p", g, place: { mode: "float", wrap: "front" } });
    expect(d).toContain('<wp:effectExtent l="0" t="0" r="0" b="0"/>');
    const turned = { ...g, rot: 30 };
    const ex = rotExtent(turned);
    expect(ex.x).toBeGreaterThan(0);
    const p = patchDocxDrawing(d, turned)!;
    expect(p).toContain(`<wp:effectExtent l="${ex.x}" t="${ex.y}" r="${ex.x}" b="${ex.y}"/>`);
    // the same rotation: what the file says stays
    const keep = d.replace('<wp:effectExtent l="0" t="0" r="0" b="0"/>', '<wp:effectExtent l="7" t="7" r="7" b="7"/>');
    expect(patchDocxDrawing(keep, { ...g, w: 120 })).toContain('<wp:effectExtent l="7" t="7" r="7" b="7"/>');
  });
});
