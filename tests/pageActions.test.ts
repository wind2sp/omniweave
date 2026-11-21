import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { PDFDocument, PDFName } from "pdf-lib";
import { useStore } from "../src/core/store";
import { newDocument, newPage } from "../src/core/types";
import { importFile } from "../src/ui/actions";
import { combineToPdf, deletePages, duplicatePages, insertBlankPage, movePagesTo, resizePages, rotatePages, splitGroups } from "../src/ui/pageActions";

const S = () => useStore.getState();

async function pdfOf(pages: number, label: string): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([200 + i, 300]).drawRectangle({ x: 10, y: 10, width: 20, height: 20 });
  d.setTitle(label);
  return d.save();
}

beforeAll(async () => {
  const pdfjs: any = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
});

beforeEach(() => {
  const doc = newDocument("정리");
  doc.pages = ["A", "B", "C", "D"].map((n) => newPage("DOCUMENT", 794, 1123, n));
  S().load(doc);
});

const names = () => S().doc.pages.map((p) => p.name).join("");

describe("page organiser actions (one undo step each)", () => {
  it("moves several pages, deletes, duplicates, and undoes", () => {
    const [a, b, c, d] = S().doc.pages.map((p) => p.id);
    movePagesTo([d, b], 0); // moved pages keep their document order
    expect(names()).toBe("BDAC");
    S().undo();
    expect(names()).toBe("ABCD");
    duplicatePages([a, c]);
    expect(S().doc.pages.map((p) => p.name)).toEqual(["A", "A 사본", "B", "C", "C 사본", "D"]);
    S().undo();
    deletePages([b, c]);
    expect(names()).toBe("AD");
    deletePages(S().doc.pages.map((p) => p.id)); // refused: one page must remain
    expect(names()).toBe("AD");
    S().undo();
    expect(names()).toBe("ABCD");
    expect(S().past.length).toBe(0);
  });
  it("rotates and resizes, inserts blank pages at a position", () => {
    const [a] = S().doc.pages.map((p) => p.id);
    rotatePages([a], 1);
    expect([S().doc.pages[0].width, S().doc.pages[0].height]).toEqual([1123, 794]);
    resizePages([a], 500, 400, false);
    expect([S().doc.pages[0].width, S().doc.pages[0].height]).toEqual([500, 400]);
    insertBlankPage(2, S().doc.pages[1]);
    expect(S().doc.pages[2].kind).toBe("DOCUMENT");
    expect(S().doc.pages.length).toBe(5);
    expect(S().past.map((p) => p.label)).toHaveLength(3);
  });
  it("split groups: every N pages or ranges", () => {
    expect(splitGroups({ kind: "every", n: 3 }, 7).groups).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(splitGroups({ kind: "ranges", text: "1-2, 4-" }, 5).groups).toEqual([[0, 1], [3, 4]]);
    expect(splitGroups({ kind: "ranges", text: "9" }, 5).error).toBeTruthy();
  });
});

describe("insert pages from another file at a position", () => {
  it("inserts only the chosen pages, where asked, as one step; old calls keep working", async () => {
    const bytes = await pdfOf(5, "five");
    const added = await importFile({ name: "five.pdf", path: null, bytes }, { at: 1, pages: "2-3, 5" });
    expect(added).toHaveLength(3);
    expect(S().doc.pages.map((p) => p.name)).toEqual(["A", "five.pdf · 2쪽", "five.pdf · 3쪽", "five.pdf · 5쪽", "B", "C", "D"]);
    expect(S().past.at(-1)!.label).toMatch(/페이지 삽입/);
    S().undo();
    expect(names()).toBe("ABCD");
    // default behaviour unchanged: after the current page
    S().set({ pageId: S().doc.pages[2].id });
    const all = await importFile({ name: "two.pdf", path: null, bytes: await pdfOf(2, "two") });
    expect(all).toHaveLength(2);
    expect(S().doc.pages[3].name).toBe("two.pdf · 1쪽");
  });
  it("a bad range is reported, nothing is added", async () => {
    const added = await importFile({ name: "x.pdf", path: null, bytes: await pdfOf(2, "x") }, { at: 0, pages: "7" });
    expect(added).toEqual([]);
    expect(names()).toBe("ABCD");
  });
});

describe("many files → one PDF", () => {
  it("keeps every page in order, embeds PDF pages as originals and adds one bookmark per file", async () => {
    const r = await combineToPdf([
      { name: "첫째.pdf", bytes: await pdfOf(2, "a") },
      { name: "둘째.pdf", bytes: await pdfOf(3, "b"), range: "1, 3" },
    ]);
    expect(r).not.toBeNull();
    expect(r!.pages).toBe(4);
    expect(r!.files).toBe(2);
    const out = await PDFDocument.load(r!.bytes);
    expect(out.getPageCount()).toBe(4);
    // page sizes come from the originals (1 px = 0.75 pt round trip)
    expect(Math.round(out.getPage(1).getWidth())).toBe(201);
    const outlines = out.catalog.lookup(PDFName.of("Outlines")) as any;
    expect(outlines.lookup(PDFName.of("Count")).asNumber()).toBe(2);
    // the open document is untouched
    expect(names()).toBe("ABCD");
  });
});
