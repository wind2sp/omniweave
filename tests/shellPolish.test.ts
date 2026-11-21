// Shell polish (2026-11-13): 파일 menu keeps the export formats in a submenu (it never grows over the menu bar), a
// template's document is named after the template, a picture opened from a file is titled without its extension
// (like DOCX · PSD · PDF), and work in progress marks the tab it was started from.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { resetSessionsForTest, useSessions } from "../src/core/sessions";
import { newDocument, newPage } from "../src/core/types";
import { newFileFromPage, openInTab } from "../src/ui/actions";
import { menuItems } from "../src/ui/menus";
import { allCommands, commandLabel } from "../src/ui/commands";
import { exportCommandList, exportMenuItems } from "../src/ui/exportMenu";
import { useProgress, withProgress } from "../src/ui/progress";
import "../src/ui/tabs";

const S = () => useStore.getState();

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

beforeEach(() => {
  S().load(newDocument());
  resetSessionsForTest();
});
afterEach(() => resetSessionsForTest());

describe("shell polish", () => {
  it("파일 menu: the export formats are one submenu item, not a long list", () => {
    const items = menuItems("file");
    const ex = items.filter((i) => i.sub);
    expect(ex).toHaveLength(1);
    expect(ex[0].sub!.length).toBeGreaterThan(8);
    expect(items.some((i) => i.label === "PPTX (.pptx)")).toBe(false);
    expect(ex[0].sub!.some((i) => i.label === "PPTX (.pptx)")).toBe(true);
    expect(items.length).toBeLessThan(22);
  });

  it("a document made from a template is named after it; without a name it stays untitled", () => {
    newFileFromPage(newPage("DOCUMENT", 794, 1123, "p"), "분기 보고서");
    expect(S().doc.title).toBe("분기 보고서");
    expect(useSessions.getState().tabs.find((t) => t.id === useSessions.getState().active)!.title).toBe("분기 보고서");
    newFileFromPage(newPage("DOCUMENT", 794, 1123, "p"));
    expect(S().doc.title).toBe(newDocument().title);
  });

  it("a picture opened from a file is titled by its name without the extension", async () => {
    await openInTab({ name: "사진.png", path: null, bytes: png(40, 30) });
    expect(S().doc.title).toBe("사진");
    expect(S().doc.pages[0].source?.name).toBe("사진.png");
  });

  it("work in progress remembers the tab it started from (its busy mark)", async () => {
    const tab = useSessions.getState().active;
    let seen: string | undefined;
    await withProgress("x", () => void (seen = useProgress.getState().tasks[0]?.tab));
    expect(seen).toBe(tab);
    expect(useProgress.getState().tasks).toHaveLength(0);
  });
});

describe("내보내기 ▸ list (ui/exportMenu.ts)", () => {
  it("groups by kind, the edit mode's formats first; formats with nothing to write are greyed with the reason", () => {
    const doc = newDocument();
    doc.pages = [newPage("DESIGN", 800, 600, "art")];
    S().load(doc);
    S().set({ mode: "IMAGE" });
    const items = exportMenuItems();
    expect(items.find((i) => i.label)!.label).toMatch(/PNG/);
    expect(items.filter((i) => i.heading).length).toBeGreaterThanOrEqual(3);
    const xlsx = items.find((i) => i.label === "XLSX (.xlsx)")!;
    expect(xlsx.disabled).toBe(true);
    expect(xlsx.tip).toBeTruthy();
    expect(items.find((i) => i.label === "Markdown (.md)")!.disabled).toBe(true);
    // the command search finds them as 내보내기 ▸ …
    expect(commandLabel(allCommands().find((c) => c.id === "export.pdf")!)).toMatch(/▸/);
    expect(exportCommandList().find((x) => x.id === "export.csv")!.enabled).toBe(false);
    S().set({ mode: "AUTO" });
  });
});
