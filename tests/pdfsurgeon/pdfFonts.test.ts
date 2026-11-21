// The editing view's copy of an embedded TrueType font (src/io/pdfsurgeon/pdfFonts.ts): a Word-made PDF's CID
// TrueType subset rebuilt with a Unicode cmap reaches the same glyphs the PDF uses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import fontkit from "@pdf-lib/fontkit";
import { modelPage, openSurgeonDoc } from "../../src/io/pdfsurgeon";
import { fontFaceSfnt } from "../../src/io/pdfsurgeon/pdfFonts";

const file = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "acro_annots.pdf");

describe("embedded font for the editing view", () => {
  it("rebuilds the CID TrueType subset with a Unicode cmap that maps to the PDF's glyphs", async () => {
    const doc = await openSurgeonDoc(new Uint8Array(readFileSync(file)));
    const m: any = modelPage(doc, 0, { prefix: "t", vectors: false } as any);
    const fonts = [...new Set(m.analysis.items.filter((x: any) => x.kind === "text" && x.font.program).map((x: any) => x.font))] as any[];
    expect(fonts.length).toBeGreaterThan(0);
    for (const f of fonts) {
      const map: Map<number, number> = f.program.uniToGid();
      expect(map.size).toBeGreaterThan(5);
      const sfnt = fontFaceSfnt(f.program.data, map, "omw-pdf-test");
      expect(sfnt).not.toBeNull();
      const font: any = fontkit.create(sfnt as any);
      for (const tag of ["cmap", "name", "post", "OS/2", "glyf", "loca"]) expect(font.directory.tables[tag]).toBeTruthy();
      let n = 0;
      for (const [cp, gid] of map) {
        expect(font.glyphForCodePoint(cp).id).toBe(gid);
        if (++n > 200) break;
      }
      // the Korean text of the page is in it
      expect([...map.keys()].some((cp) => cp >= 0xac00 && cp <= 0xd7a3)).toBe(true);
    }
  });

  it("refuses what it cannot rebuild", () => {
    expect(fontFaceSfnt(new Uint8Array(64), new Map([[65, 1]]), "x")).toBeNull();
    expect(fontFaceSfnt(new Uint8Array(64), new Map(), "x")).toBeNull();
  });
});
