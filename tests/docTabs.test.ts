// Document tabs (core/sessions.ts, docs/design/SHELL_LAYOUT.md §5): each tab keeps its own document, undo stack,
// selection, view, work mode, file path, dirty flag and history timeline; opening reuses an untouched tab;
// the menus keep every command they had before the top bar was rebuilt.
import { beforeEach, describe, expect, it } from "vitest";
import { useHistory } from "../src/core/history";
import { draftPage, useStore } from "../src/core/store";
import {
  activeSessionId,
  dirtyTabs,
  isPristineActive,
  moveTab,
  newSession,
  removeSession,
  resetSessionsForTest,
  sessionDoc,
  setOpenedPath,
  setPinned,
  switchTo,
  tabForPath,
  tabTitle,
  useSessions,
} from "../src/core/sessions";
import { newDocument, newText } from "../src/core/types";
import { loadNewDocument } from "../src/ui/actions";
import { MENUS, menuCommandIds } from "../src/ui/menus";
import { command } from "../src/ui/commands";
import "../src/ui/tabs";

const S = () => useStore.getState();
const tabs = () => useSessions.getState().tabs;

function addText(label: string) {
  const n = newText(label);
  S().commit(label, (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
  return n;
}

beforeEach(() => {
  S().load(newDocument());
  resetSessionsForTest();
});

describe("document sessions", () => {
  it("parks and restores the whole per-document state", () => {
    const a = activeSessionId();
    S().load(newDocument("A"), "C:\\work\\a.omw");
    const na = addText("in A");
    S().set({ selection: [na.id], mode: "SLIDE", view: { zoom: 2, panX: 5, panY: 6 } });
    const docA = S().doc;

    const b = newSession();
    expect(tabs().map((t) => t.id)).toEqual([a, b]);
    expect(S().doc).not.toBe(docA);
    expect(S().past).toHaveLength(0);
    expect(S().dirty).toBe(false);
    expect(S().filePath).toBeNull();
    expect(S().mode).toBe("AUTO");
    addText("in B");
    expect(useHistory.getState().entries.at(-1)?.label).toBe("in B");

    expect(switchTo(a)).toBe(true);
    expect(S().doc).toBe(docA);
    expect(S().selection).toEqual([na.id]);
    expect(S().mode).toBe("SLIDE");
    expect(S().view.zoom).toBe(2);
    expect(S().filePath).toBe("C:\\work\\a.omw");
    expect(S().past.map((e) => e.label)).toEqual(["in A"]);
    expect(useHistory.getState().entries.map((e) => e.label)).toContain("in A");
    expect(useHistory.getState().entries.map((e) => e.label)).not.toContain("in B");
    // undo works on this tab's own stack
    S().undo();
    expect(S().doc.pages[0].nodes.some((n) => n.id === na.id)).toBe(false);
    expect(sessionDoc(b)?.pages[0].nodes.some((n) => n.type === "TEXT")).toBe(true);
  });

  it("keeps each tab's meta (title, dirty, path) apart while switching", () => {
    const a = activeSessionId();
    S().commit("title", (d) => void (d.title = "Report"));
    const b = newSession();
    S().commit("title", (d) => void (d.title = "Deck"));
    switchTo(a);
    const [ta, tb] = tabs();
    expect([ta.id, ta.title, ta.dirty]).toEqual([a, "Report", true]);
    expect([tb.id, tb.title, tb.dirty]).toEqual([b, "Deck", true]);
    expect(dirtyTabs()).toHaveLength(2);
  });

  it("an untouched new document is reused instead of opening another tab", () => {
    expect(isPristineActive()).toBe(true);
    const doc = newDocument("Template");
    loadNewDocument(doc);
    expect(tabs()).toHaveLength(1);
    addText("x");
    expect(isPristineActive()).toBe(false);
    loadNewDocument(newDocument("Second"));
    expect(tabs()).toHaveLength(2);
    expect(S().doc.title).toBe("Second");
    // a new blank document asked for on purpose is not reused by the next one
    const blank = newDocument("Blank");
    blank.pages[0].nodes = [];
    loadNewDocument(blank);
    loadNewDocument(newDocument("Third"));
    expect(tabs()).toHaveLength(4);
  });

  it("finds a tab by the file it came from or was saved to", () => {
    const a = activeSessionId();
    setOpenedPath(a, "C:/docs/Report.DOCX");
    newSession();
    expect(tabForPath("c:\\docs\\report.docx")).toBe(a);
    expect(tabForPath("C:/docs/other.docx")).toBeNull();
  });

  it("closing the active tab activates its right neighbour; the last one leaves an empty document", () => {
    const a = activeSessionId();
    const b = newSession();
    const c = newSession();
    switchTo(b);
    removeSession(b);
    expect(activeSessionId()).toBe(c);
    removeSession(c);
    expect(activeSessionId()).toBe(a);
    removeSession(a);
    expect(tabs()).toHaveLength(1);
    expect(isPristineActive()).toBe(true);
  });

  it("reorders tabs and keeps pinned ones in front", () => {
    const a = activeSessionId();
    const b = newSession();
    const c = newSession();
    moveTab(c, 0);
    expect(tabs().map((t) => t.id)).toEqual([c, a, b]);
    setPinned(b, true);
    expect(tabs().map((t) => t.id)).toEqual([b, c, a]);
    moveTab(a, 0); // an unpinned tab cannot go before a pinned one
    expect(tabs().map((t) => t.id)).toEqual([b, a, c]);
  });

  it("numbers untitled documents like Word's Document2", () => {
    newSession();
    const [t1, t2] = tabs();
    const shown = (s: string) => (s === "제목 없음" ? "Untitled" : s);
    expect(tabTitle(t1, shown)).toBe("Untitled");
    expect(tabTitle(t2, shown)).toBe("Untitled 2");
  });
});

describe("menus after the top bar rebuild", () => {
  it("keep every command of the old menus and add the tab commands", () => {
    const ids = menuCommandIds();
    for (const id of ["file.new", "file.open", "file.openSource", "file.importPages", "file.save", "file.saveAs", "file.saveProtected", "file.print", "file.settings", "file.quit", "edit.undo", "edit.redo", "edit.history", "view.theme", "tools.commandSearch", "help.about"])
      expect(ids).toContain(id);
    for (const id of ["file.saveAll", "file.closeTab", "file.closeAllTabs", "view.nextTab", "view.prevTab"]) {
      expect(ids).toContain(id);
      expect(command(id)).toBeTruthy();
    }
  });

  it("File ▸ Close Document is in the upper group with open / save (Word, 한글), not under Print", () => {
    const file = MENUS.find((m) => m.id === "file")!.entries;
    const at = (id: string) => file.indexOf(id);
    expect(at("file.closeTab")).toBeGreaterThan(at("file.open"));
    expect(at("file.closeTab")).toBeLessThan(at("file.save"));
    expect(at("file.closeAllTabs")).toBe(at("file.closeTab") + 1);
    expect(command("file.closeTab")?.kbd).toBe("Ctrl+W");
  });
});
