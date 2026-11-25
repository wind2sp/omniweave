// Recent files (ui/shell/recent.ts): pinned files stay at the top and are never pushed out by newer ones (Word's
// 목록에 고정); the template search on the start screen knows paper and screen names (ui/shell/templates.ts).
import { beforeEach, describe, expect, it } from "vitest";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { clearRecent, rememberRecent, togglePinRecent, useRecent } = await import("../../src/ui/shell/recent");
const { sizeNames, toPx } = await import("../../src/ui/shell/templates");

const names = () => useRecent.getState().list.map((x) => x.name + (x.pinned ? "*" : ""));

describe("recent files: pin", () => {
  beforeEach(() => clearRecent());

  it("keeps a pinned file first while newer files come and go", () => {
    rememberRecent("C:\\a\\one.docx", "one.docx");
    rememberRecent("C:\\a\\two.pdf", "two.pdf");
    togglePinRecent("C:\\a\\one.docx");
    expect(names()).toEqual(["one.docx*", "two.pdf"]);
    for (let i = 0; i < 10; i++) rememberRecent(`C:\\a\\n${i}.png`, `n${i}.png`);
    const list = names();
    expect(list[0]).toBe("one.docx*");
    // eight unpinned besides the pinned one
    expect(list.length).toBe(9);
    expect(list).not.toContain("two.pdf");
    // opening the pinned file again keeps it pinned; unpinning puts it back by its time
    rememberRecent("C:\\a\\one.docx", "one.docx");
    expect(names()[0]).toBe("one.docx*");
    togglePinRecent("C:\\a\\one.docx");
    expect(names()[0]).toBe("one.docx");
    expect(names().every((n) => !n.endsWith("*"))).toBe(true);
  });

  it("is kept across starts (localStorage)", () => {
    rememberRecent("C:\\a\\keep.hwpx", "keep.hwpx");
    togglePinRecent("C:\\a\\keep.hwpx");
    expect(JSON.parse(store.get("omniweave.recent.v1")!)[0]).toMatchObject({ name: "keep.hwpx", pinned: true });
  });
});

describe("start screen search: size names", () => {
  it("names A4 and FHD either way round", () => {
    expect(sizeNames(toPx(210, "mm"), toPx(297, "mm"))).toMatch(/A4/);
    expect(sizeNames(toPx(297, "mm"), toPx(210, "mm"))).toMatch(/A4/);
    expect(sizeNames(1920, 1080)).toMatch(/FHD/);
    expect(sizeNames(1000, 777)).toBe("");
  });
});
