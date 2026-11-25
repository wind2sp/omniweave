// A CSV opened with 열기 is a sheet page (Excel opens CSV on a worksheet), and saved back as CSV it keeps the file:
// encoding, BOM, delimiter, quoting and every record nobody edited, byte for byte.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

async function open(path: string): Promise<OmwDocument> {
  const bytes = new Uint8Array(readFileSync(path));
  const r = await formatForExt("csv")!.open({ name: path.split("/").pop()!, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("csv")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;

describe("CSV as a sheet", () => {
  for (const f of ["qa/interop/omniweave-made/csv-02-utf8-bom.csv", "qa/interop/omniweave-made/csv-01-cp949.csv"])
    it(`${f}: opens on a sheet and saves back unchanged`, async () => {
      const doc = await open(f);
      expect(doc.pages).toHaveLength(1);
      expect(doc.pages[0].sheet).toBeTruthy();
      expect(doc.pages[0].source?.format).toBe("csv");
      const out = await save(doc);
      expect(Buffer.from(out).equals(readFileSync(f))).toBe(true);
    });

  it("an edited cell is the only change", async () => {
    const f = "qa/interop/omniweave-made/csv-02-utf8-bom.csv";
    const doc = await open(f);
    const sh = doc.pages[0].sheet!;
    sh.cells.B2 = { v: 77123 };
    const out = Buffer.from(await save(doc)).toString("utf8");
    const was = readFileSync(f, "utf8");
    expect(out).toContain("77123");
    expect(out.split(/\r?\n/).filter((l, i) => l !== was.split(/\r?\n/)[i]).length).toBe(1);
  });
});
