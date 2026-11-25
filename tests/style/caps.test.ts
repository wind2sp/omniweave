// Capability table queries (core/style/caps.ts): levels, per-kind overrides and the export issue list.
import { describe, expect, it } from "vitest";
import { CAP_FORMATS, CAP_PROPS, capOf, capsMatrix, exportIssues, formatsWith, summarizeIssues } from "../../src/core/style";
import { newPage, newTable, newText, newVector } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";

describe("caps table", () => {
  it("every row names a level for every format, ids are unique, readGap formats are native writes", () => {
    expect(new Set(CAP_PROPS.map((p) => p.id)).size).toBe(CAP_PROPS.length);
    for (const p of CAP_PROPS) {
      for (const row of [p.row, ...Object.values(p.byNode ?? {})]) expect(row, p.id).toMatch(new RegExp(`^[NARD]{${CAP_FORMATS.length}}$`));
      for (const f of p.readGap ?? []) expect(capOf(p.id, f), `${p.id} ${f}`).toBe("native");
    }
    // PNG is a picture of the page: everything that shows looks the same (data-only fields such as formulas are lost)
    for (const p of CAP_PROPS) expect(capOf(p.id, "png"), p.id).toBe(p.id === "table.formula" || p.id === "table.numFmt" ? "drop" : "native");
  });

  it("queries", () => {
    expect(capOf("blend", "psd")).toBe("native");
    expect(capOf("blend", "pptx")).toBe("drop");
    expect(capOf("fill.solid", "docx", "TABLE")).toBe("native");
    expect(capOf("fill.solid", "docx", "VECTOR")).toBe("native"); // shapes since io/officeShapes.ts
    expect(capOf("fill.solid", "xlsx", "VECTOR")).toBe("drop");
    expect(capOf("no.such.prop", "pdf")).toBe("drop");
    expect(formatsWith("table.formula")).toEqual(["xlsx", "png"].filter((f) => capOf("table.formula", f as any) === "native"));
    expect(capsMatrix()).toHaveLength(CAP_PROPS.length);
  });

  it("export issues report a lost object once and lost properties of kept objects", () => {
    const p = newPage("DOCUMENT");
    const v = { ...newVector([rectContour(0, 0, 10, 10)]), opacity: 0.5 };
    const t = newText("x", 200, { strike: true });
    t.blendMode = "MULTIPLY";
    p.nodes = [v, t, newTable([["a"]])];
    const docx = exportIssues([p], "docx");
    // (a shape is kept since io/officeShapes.ts: only its opacity is lost)
    expect(docx.filter((i) => i.nodeId === v.id)).toEqual([{ pageId: p.id, nodeId: v.id, prop: "opacity", level: "drop" }]);
    expect(exportIssues([p], "xlsx").filter((i) => i.nodeId === v.id)).toEqual([{ pageId: p.id, nodeId: v.id, prop: "node.VECTOR", level: "drop" }]);
    const textIssues = docx.filter((i) => i.nodeId === t.id).map((i) => i.prop);
    expect(textIssues).toContain("blend");
    expect(textIssues).not.toContain("node.TEXT");
    expect(textIssues).not.toContain("text.strike");
    const pptx = summarizeIssues(exportIssues([p], "pptx"));
    expect(pptx).toContainEqual({ prop: "opacity", level: "drop", count: 1 });
    expect(pptx).toContainEqual({ prop: "blend", level: "drop", count: 1 });
    expect(exportIssues([p], "png")).toEqual([]);
    expect(exportIssues([p], "xlsx").map((i) => i.prop)).toEqual(["node.VECTOR", "node.TEXT"]);
    // hidden objects are not saved anyway
    p.nodes = [{ ...v, visible: false }];
    expect(exportIssues([p], "docx")).toEqual([]);
  });
});
