// Duplicating a PDF page (core/types.ts copyNode): the copy's annotations get ids of their own, so they are edited,
// deleted and written apart from the original page's.
import { describe, expect, it } from "vitest";
import { copyNode, newPdf, type PdfNode } from "../../src/core/types";

describe("duplicated PDF page annotations", () => {
  it("gives the copy's annotations new ids and leaves the original's alone", () => {
    const n: PdfNode = { ...newPdf("as1", 0, 600, 800), annots: [{ id: "omw-a1", kind: "note", at: [10, 20], color: [1, 0.8, 0.2], contents: "QA" }] };
    const c = copyNode(n, "n2");
    expect(c.id).toBe("n2");
    expect(c.annots).toHaveLength(1);
    expect(c.annots![0].id).not.toBe("omw-a1");
    expect({ ...c.annots![0], id: "x" }).toEqual({ ...n.annots![0], id: "x" });
    expect(n.annots![0].id).toBe("omw-a1");
    expect(copyNode(newPdf("as1", 0, 600, 800), "n3").annots).toBeUndefined();
  });
});
