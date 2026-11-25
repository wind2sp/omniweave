// DrawingML readers for Word shapes (wps:wsp, io/officeShapes.ts shapeOfWsp): colours through the document's theme
// (a:schemeClr — Word's default shape style takes its fill and line from accent1), geometry through the PPTX geometry
// reader (pptxGeom.ts: preset shapes, a:custGeom).

import type { DmlReaders } from "../officeShapes";
import { attr, child, children, descendants } from "../xml";
import { colorOf } from "./pptx";
import { avOf, custContours, flipContours, presetContours } from "./pptxGeom";

const EMU = 9525;

/** The readers for a DOCX whose theme part is `theme` (null: no theme — scheme colours read as none). */
export function docxDml(theme: Document | null): DmlReaders {
  const th: Record<string, string> = {};
  const cs = theme && descendants(theme, "clrScheme")[0];
  if (cs) for (const c of children(cs)) th[c.localName] = colorOf(c, {}) ?? "#000000";
  return {
    fill(spPr, style) {
      if (spPr) {
        if (child(spPr, "noFill")) return null;
        const sf = child(spPr, "solidFill");
        if (sf) return colorOf(sf, th);
        const gf = child(spPr, "gradFill");
        if (gf) return colorOf(descendants(gf, "gs")[0], th);
      }
      const ref = style && child(style, "fillRef");
      if (ref && attr(ref, "idx") !== "0") return colorOf(ref, th);
      return undefined;
    },
    line(spPr, style) {
      const ln = spPr && child(spPr, "ln");
      // (no width given: the theme line of Word's shape style, 1 pt)
      const w = ln && attr(ln, "w") ? Number(attr(ln, "w")) / EMU : 12700 / EMU;
      if (ln) {
        if (child(ln, "noFill")) return { color: null, width: 0 };
        const sf = child(ln, "solidFill");
        if (sf) return { color: colorOf(sf, th), width: w };
      }
      const ref = style && child(style, "lnRef");
      if (ref && attr(ref, "idx") !== "0") return { color: colorOf(ref, th), width: w };
      return { color: null, width: 0 };
    },
    preset: (prst, w, h, geom) => presetContours(prst, w, h, avOf(geom)),
    cust: custContours,
    flip: flipContours,
  };
}
