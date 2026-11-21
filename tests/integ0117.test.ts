// Integration QA for 0.1.7 (polish-1113 + ui-modeswitch, 2026-11-13):
// · unedited Word / 한글 / PowerPoint / Photoshop files save their own bytes through the new export steps
//   (adjustment baking only where a showing adjustment layer is, WebP → PNG only for pictures the person added);
// · the command search (Ctrl+K) lists the same 내보내기 rows as the menus, and a greyed row says why;
// · the run mark is read once per page load (StrictMode runs the startup effect twice in development).
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { useStore } from "../src/core/store";
import { newDocument, newPage, type OmwDocument } from "../src/core/types";
import { bakeAdjustDoc, bakeCount } from "../src/io/bakeAdjust";
import { formatForExt, sameTypeExport } from "../src/io/formats";
import { importPsdPage } from "../src/io/formats/psd";
import { webpToPng } from "../src/io/webpPolicy";
import { allCommands, commandLabel, enabled } from "../src/ui/commands";
import { exportMenuItems } from "../src/ui/exportMenu";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const same = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const noRaster = async () => {
  throw new Error("nothing should be baked");
};

describe("unedited files keep their bytes through the export steps", () => {
  const OFFICE = ["qa/samples/doc-features/omni-sample.docx", "qa/samples/doc-features/omni-sample.hwpx", "qa/interop/adobe-made/omni-pptx-media.pptx"];
  for (const f of OFFICE) {
    it(f, async () => {
      const bytes = new Uint8Array(readFileSync(f));
      const ext = f.slice(f.lastIndexOf(".") + 1);
      const r = await formatForExt(ext)!.open({ name: f.slice(f.lastIndexOf("/") + 1), path: null, bytes }, {} as any);
      const doc = { ...newDocument(), pages: r.pages, assets: (r as any).assets ?? {} } as OmwDocument;
      // no adjustment layers: passed through as they are; no WebP added by the person: the same document
      const b = await bakeAdjustDoc(doc, doc.pages, noRaster);
      expect(b.baked).toBe(0);
      expect(b.doc.pages).toEqual(doc.pages);
      expect(await webpToPng(doc, async () => null)).toBe(doc);
      const out = (await sameTypeExport(doc.pages[0])!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
      expect(same(out, bytes)).toBe(true);
    });
  }

  it("a PSD with adjustment layers: 'save as PSD' is the original bytes (baking is for PDF / SVG / Office only)", async () => {
    const name = "omni-fid-adj-curves.psd";
    const bytes = new Uint8Array(readFileSync("qa/interop/adobe-made/fidelity/" + name));
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
    const { page } = importPsdPage(bytes, name, "t", asset);
    const doc: OmwDocument = { ...newDocument(), pages: [page], assets: { [asset.id]: asset } };
    expect(bakeCount(page)).toBeGreaterThan(0);
    const def = sameTypeExport(page)!;
    expect(def.ext).toBe("psd");
    expect(same((await def.run(doc, page, { confirm: () => true } as any)) as Uint8Array, bytes)).toBe(true);
  });
});

describe("내보내기 ▸ in the command search", () => {
  it("lists the menu's rows in the menu's order; a greyed row carries the menu's reason", () => {
    const doc = newDocument();
    doc.pages = [newPage("DESIGN", 800, 600, "art")];
    useStore.getState().load(doc);
    const menu = exportMenuItems().filter((i) => i.label);
    const cmds = allCommands().filter((c) => c.id.startsWith("export."));
    expect(cmds.map((c) => commandLabel(c).split(" ▸ ")[1])).toEqual(menu.map((i) => i.label));
    menu.forEach((m, i) => {
      expect(enabled(cmds[i])).toBe(!m.disabled);
      expect(cmds[i].whyNot?.() ?? null).toBe(m.disabled ? m.tip : null);
    });
    expect(cmds.some((c) => !enabled(c) && c.whyNot?.())).toBe(true);
  });
});

describe("run mark", () => {
  it("startRunOnce: a second call in the same page load gives the first answer (not a crash)", async () => {
    const mem = new Map<string, string>();
    (globalThis as any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
    const { startRunOnce } = await import("../src/io/journal");
    expect(startRunOnce()).toBe(false);
    expect(startRunOnce()).toBe(false);
    delete (globalThis as any).localStorage;
  });
});
