// Layer effects in the exporters: PPTX a:effectLst XML (and back), SVG filters around the live markup, the vector
// PDF's effect pictures (soft-masked images under / over vector content), DOCX character shadow.
import { strFromU8, unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { encodePng } from "../../src/core/image/png";
import { newEffect, type Effect } from "../../src/core/style";
import { newDocument, newPage, newText, newVector, type SceneNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { exportSvg } from "../../src/io/export";
import { exportDocx } from "../../src/io/office";
import { exportPdfVector } from "../../src/io/pdfVector";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { effectLstXml, readEffectLst } from "../../src/io/formats/pptxFx";
import { parseXml } from "../../src/io/xml";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const px = (v: number) => ({ v, u: "px" as const });
const shadow: Effect = { type: "dropShadow", on: true, blend: "MULTIPLY", opacity: 0.5, color: { hex: "#1d1f24" }, angle: 120, distance: px(10), spread: 0, size: px(6) };
const shape = (fx: Effect[]) => ({ ...newVector([rectContour(0, 0, 200, 100)]), name: "OMNI", fill: "#4f7cff", transform: { x: 100, y: 80, rotation: 0, scale: 1 }, effects: fx }) as SceneNode;

describe("PPTX a:effectLst", () => {
  it("drop shadow → outerShdw with blurRad / dist / dir (Photoshop angle → DrawingML) and alpha; schema order", () => {
    const x = effectLstXml([{ type: "softEdge", on: true, radius: px(4) }, shadow, newEffect("outerGlow"), newEffect("innerShadow")]);
    expect(x).toBe(
      '<a:effectLst><a:glow rad="47625"><a:srgbClr val="FFFFBE"><a:alpha val="75000"/></a:srgbClr></a:glow>' +
        '<a:innerShdw blurRad="47625" dist="47625" dir="3600000"><a:srgbClr val="000000"><a:alpha val="75000"/></a:srgbClr></a:innerShdw>' +
        '<a:outerShdw blurRad="57150" dist="95250" dir="3600000" algn="ctr" rotWithShape="0"><a:srgbClr val="1D1F24"><a:alpha val="50000"/></a:srgbClr></a:outerShdw>' +
        '<a:softEdge rad="38100"/></a:effectLst>',
    );
    expect(effectLstXml([{ ...shadow, on: false }])).toBe("");
    // ST_PositiveFixedAngle is < 21600000: an angle a hair past 180° must not round up to 360°
    expect(effectLstXml([{ ...shadow, angle: 180.0000001 } as Effect])).toContain('dir="0"');
    const back = readEffectLst(parseXml(`<a:spPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${x}</a:spPr>`).documentElement, (el) => {
      const c = el && Array.from(el.childNodes).find((n: any) => n.localName === "srgbClr") as Element | undefined;
      return c ? "#" + c.getAttribute("val")!.toLowerCase() : null;
    });
    expect(back.map((e) => e.type)).toEqual(["outerGlow", "innerShadow", "dropShadow", "softEdge"]);
    expect(back[2]).toMatchObject({ angle: 120, distance: { v: 10 }, size: { v: 6 }, opacity: 0.5, color: { hex: "#1d1f24" } });
  });

  it("a shape and a text box keep their effects through PPTX; an inner glow makes the object a picture", async () => {
    const doc = newDocument("omni");
    const p = newPage("SLIDE", 1280, 720, "P");
    const t = newText("OMNI");
    t.transform = { x: 40, y: 40, rotation: 0, scale: 1 };
    t.effects = [shadow];
    p.nodes = [shape([shadow]), t, shape([newEffect("innerGlow")])];
    doc.pages = [p];
    const r = await exportPptx(doc, [p]);
    const slide = strFromU8(unzipSync(r.bytes)["ppt/slides/slide1.xml"]);
    expect(slide.match(/<a:outerShdw /g)).toHaveLength(2);
    expect(slide).toMatch(/<\/a:ln><a:effectLst><a:outerShdw/);
    expect(r.warnings.some((w) => /PPTX 형식에 없는/.test(w))).toBe(true);
    const back = importPptx(r.bytes, "x.pptx").pages[0].nodes;
    expect(back.find((n) => n.type === "VECTOR")!.effects?.[0]).toMatchObject({ type: "dropShadow", distance: { v: 10 }, angle: 120 });
    expect(back.find((n) => n.type === "TEXT")!.effects?.[0].type).toBe("dropShadow");
  });
});

describe("SVG export", () => {
  it("wraps the live path in a <g> with the effects filter in page space", async () => {
    const doc = newDocument("omni");
    const p = newPage("DESIGN", 400, 300, "P");
    p.nodes = [shape([shadow, newEffect("fxStroke")])];
    doc.pages = [p];
    const svg = await exportSvg(doc, p);
    expect(svg).toMatch(/<g filter="url\(#fx-[^"]+\)"><defs><filter id="fx-[^"]+" filterUnits="userSpaceOnUse"/);
    expect(svg).toContain("<path ");
    expect(svg).toContain('<feOffset in="e0" dx="5" dy="8.66"');
    expect(svg).toContain('operator="dilate" radius="3"');
  });
});

describe("vector PDF", () => {
  it("places the shadow as a soft-masked image under the vector shape (the shape stays a path)", async () => {
    const doc = newDocument("omni");
    const p = newPage("DESIGN", 400, 300, "P");
    p.nodes = [shape([shadow])];
    doc.pages = [p];
    // stand-in for the browser rasteriser: the node's pixels (blue rectangle) at 2×
    const rgba = new Uint8Array(400 * 200 * 4);
    for (let i = 0; i < 400 * 200; i++) rgba.set([79, 124, 255, 255], i * 4);
    let asked: SceneNode | null = null;
    const bytes = await exportPdfVector(doc, [p], {
      rasterize: async (_pg, n) => {
        asked = n;
        return { png: encodePng(rgba, 400, 200, 4), x: 100, y: 80, w: 200, h: 100 };
      },
      outline: false,
    });
    expect(asked!.effects).toBeUndefined(); // the content is rendered without its effects
    const s = new TextDecoder("latin1").decode(bytes);
    expect(s).toMatch(/\/SMask \d+ 0 R/);
    expect(s).toMatch(/\/Subtype \/Image/);
  });
});

describe("DOCX", () => {
  it("a text box with a drop shadow gets Word's character shadow", () => {
    const p = newPage("DOCUMENT", 794, 1123, "P");
    const t = newText("OMNI");
    t.effects = [shadow];
    const u = newText("plain");
    u.transform = { ...u.transform, y: 200 };
    p.nodes = [t, u];
    const xml = strFromU8(unzipSync(exportDocx([p]))["word/document.xml"]);
    expect(xml.match(/<w:shadow\/>/g)).toHaveLength(1);
    expect(xml).toMatch(/<w:strike\/>|<w:b\/>|<w:rFonts[^>]*\/><w:shadow\/><w:color/);
  });
});
