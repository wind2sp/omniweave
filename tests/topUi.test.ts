// Top of the window rebuilt (docs/design/UI_TOP_REDESIGN.md, 제품 결정 2026-11-20; issues 2-2 · 3 · 4 · 6):
// · no command of the old menu bar is lost — each is in the backstage (파일), a ribbon tab, an image / design drop-down
//   menu or the toolbox, and all of them in command search (the coverage list below is built from the old menus);
// · the tab set follows the page's FORMAT: Word / HWP, PDF, CAD, slides, images, designs — and a PDF never gets the
//   word processor's tabs, whatever the work mode;
// · the work mode switch keeps all five modes and shrinks (icons → one drop-down) only when the row does not fit.
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, type Page } from "../src/core/types";
import { allCommands, command, commandLabel, listed } from "../src/ui/commands";
import { PROFILES, editModeOf, fixedFormatOf, isPdfFormatPage, useCadScreen } from "../src/ui/editModes";
import { BACKSTAGE, DESIGN_MENUS, IMAGE_MENUS, PENDING_COMMANDS, backstageCommandIds, menuCommandIds, modeMenuCommandIds, modeMenuItems } from "../src/ui/menus";
import { RIBBON_TABS, activeTab, surfaceOf, type Surface } from "../src/ui/ribbonTabs";
import { COMPACT_STEPS, TabRow, keyTipAlt, nextCompactStep } from "../src/ui/shell/TopBar";
import { setWorkMode } from "../src/ui/shell/ModeSwitch";
import { DICTS, t } from "../src/i18n";

const S = () => useStore.getState();

/** Ribbon panels whose buttons run commands by id (run("…") / CmdBig id="…"). */
const RIBBON_SOURCES: Record<string, string> = {
  doc: "src/ui/shell/DocRibbon.tsx",
  pdf: "src/ui/shell/PdfRibbon.tsx",
  slide: "src/ui/shell/SlideRibbon.tsx",
  titlebar: "src/ui/shell/TopBar.tsx",
};
const sources = Object.fromEntries(Object.entries(RIBBON_SOURCES).map(([k, f]) => [k, readFileSync(f, "utf8")]));

/** Old menu commands that are tools: their place is the toolbox of the modes that offer the tool. */
const TOOLBOX: Record<string, string> = { "image.brush": "brush", "image.eraser": "eraser", "insert.rect": "rect", "insert.ellipse": "ellipse", "insert.pen": "pen", "insert.text": "text" };
/** Shown in the title bar itself. */
const TITLEBAR: Record<string, string> = { "tools.commandSearch": "CommandSearch", "view.theme": "theme" };

/** Where an old menu command lives now (the coverage list). */
function homesOf(id: string): string[] {
  const out: string[] = [];
  for (const b of BACKSTAGE) if (b.entries.includes(id)) out.push(`파일 › ${b.id}`);
  for (const m of IMAGE_MENUS) if (modeMenuCommandIds("image").includes(id) && JSON.stringify(m.entries).includes(`"${id}"`)) out.push(`이미지 메뉴 › ${m.id}`);
  for (const m of DESIGN_MENUS) if (JSON.stringify(m.entries).includes(`"${id}"`)) out.push(`디자인 메뉴 › ${m.id}`);
  for (const [k, src] of Object.entries(sources)) if (src.includes(`"${id}"`)) out.push(`리본 › ${k}`);
  if (TOOLBOX[id] && (PROFILES.IMAGE.tools.includes(TOOLBOX[id] as any) || PROFILES.DESIGN.tools.includes(TOOLBOX[id] as any))) out.push(`도구상자 › ${TOOLBOX[id]}`);
  if (TITLEBAR[id] && sources.titlebar.includes(TITLEBAR[id])) out.push("제목 줄");
  return out;
}

describe("no command of the old menu bar is lost", () => {
  const ids = [...new Set(menuCommandIds())];
  it("the coverage list has every old menu command (and the old menus are not empty)", () => {
    expect(ids.length).toBeGreaterThan(120);
    const lost = ids.filter((id) => homesOf(id).length === 0);
    expect(lost, `no visible home: ${lost.join(", ")}`).toEqual([]);
  });
  it("every old menu command is registered and found by command search (Alt+Q)", () => {
    const search = new Set(allCommands().map((c) => c.id));
    for (const id of ids) {
      const c = command(id);
      expect(c, id).toBeTruthy();
      // desktop-only commands (끝내기, 업데이트 확인) are listed where the desktop app runs
      if (listed(c!)) expect(search.has(id), id).toBe(true);
    }
  });
  it("the backstage and the drop-down menus only name registered commands (pending slots excepted)", () => {
    for (const id of [...backstageCommandIds(), ...modeMenuCommandIds("image"), ...modeMenuCommandIds("design")]) {
      if (PENDING_COMMANDS.includes(id)) continue;
      expect(command(id), id).toBeTruthy();
    }
  });
  it("업스케일 (image-upscale, merged 2026-11-21) is in the image menu right after the canvas size, and in the design mode's 개체 menu", () => {
    expect(PENDING_COMMANDS).toEqual([]);
    expect(command("image.upscale")).toBeTruthy();
    const image = IMAGE_MENUS.find((m) => m.id === "image")!.entries;
    expect(image.indexOf("image.upscale")).toBe(image.indexOf("image.canvasSize") + 1);
    const label = commandLabel(command("image.upscale")!);
    expect(label).toContain(t("cmd.image.upscale"));
    expect(t("cmd.image.upscale")).not.toBe("cmd.image.upscale");
    const items = modeMenuItems("image", "image").map((i) => i.label ?? "");
    expect(items.indexOf(label), items.join(" | ")).toBe(items.indexOf(commandLabel(command("image.canvasSize")!)) + 1);
    expect(modeMenuItems("design", "object").map((i) => i.label)).toContain(label);
  });
  it("issue 2-2: flip, rotate and canvas size are in the image menu; crop and painting are toolbox tools", () => {
    const image = JSON.stringify(IMAGE_MENUS.find((m) => m.id === "image")!.entries);
    for (const id of ["object.flipH", "object.flipV", "page.rotateRight", "page.rotateLeft", "image.canvasSize", "image.cropCanvas", "object.crop"]) expect(image, id).toContain(`"${id}"`);
    expect(PROFILES.IMAGE.tools).toEqual(expect.arrayContaining(["brush", "gradient"]));
    // the options bar no longer ends with its own flip / paint group in the image and design modes
    const ribbon = readFileSync("src/ui/shell/Ribbon.tsx", "utf8");
    expect(ribbon).toContain("withFlip={!optionsBar}");
    expect(ribbon).toContain("!optionsBar && kinds.length === 1");
  });
  it("every command the old ribbon ran (before the redesign, 240c513) still has a visible home", () => {
    // run("…") / CmdBig id / data-cmd of the old DocRibbon.tsx · Ribbon.tsx · TopBar.tsx (QA 2026-11-21)
    const OLD_RIBBON = ["edit.copy", "edit.cut", "edit.find", "edit.paste", "edit.replace", "insert.docPage", "insert.endnote", "insert.footer", "insert.footnote", "insert.header", "insert.image", "insert.pageBreak", "insert.pageNumber", "insert.sectionBreak", "insert.symbol", "insert.table", "page.setup", "review.newComment", "review.track", "tools.commandSearch"];
    for (const id of OLD_RIBBON) {
      expect(homesOf(id), id).not.toEqual([]);
      if (command(id) && listed(command(id)!)) expect(allCommands().some((c) => c.id === id), id).toBe(true);
    }
  });
  it("업스케일 is reachable from the image menu, the design 개체 menu, the picture's right-click menu and command search", () => {
    expect(modeMenuCommandIds("image")).toContain("image.upscale");
    expect(modeMenuCommandIds("design")).toContain("image.upscale");
    expect(readFileSync("src/ui/CanvasView.tsx", "utf8")).toMatch(/cmd\.image\.upscale[\s\S]{0,120}kind: "upscale"/);
    expect(allCommands().some((c) => c.id === "image.upscale")).toBe(true);
    // the old right-hand image group of the options bar stays gone (issue 2-2): no upscale / flip / paint buttons there
    expect(readFileSync("src/ui/shell/Ribbon.tsx", "utf8")).not.toContain("image.upscale.ribbon");
  });
  it("prints the coverage list (old menu → new place)", () => {
    const rows = ids.map((id) => `${id} → ${homesOf(id).join(" · ")}`);
    expect(rows.length).toBe(ids.length);
  });
});

// ───────── tab sets by format ─────────

const page = (kind: Page["kind"], format?: string, extra: Partial<Page> = {}): Page => {
  const p = newPage(kind, 800, 600);
  if (format) p.source = { format, name: `a.${format}` } as any;
  return Object.assign(p, extra);
};
const MODES = ["AUTO", "DOCUMENT", "SLIDE", "IMAGE", "DESIGN"] as const;
const WORD_TABS = ["home", "insert", "layout", "references", "review", "view", "draw"];

describe("tabs follow the file format", () => {
  beforeEach(() => useCadScreen.getState().set(true));
  it("Word / HWP: 홈 · 삽입 · 레이아웃 · 참조 · 검토 · 보기 · 그리기", () => {
    expect(RIBBON_TABS.doc).toEqual(WORD_TABS);
    for (const f of ["docx", "hwp", "hwpx"]) expect(surfaceOf(page("DOCUMENT", f), "AUTO")).toBe("doc");
  });
  it("PDF: its own first tab, and never the word processor's tabs in any work mode", () => {
    expect(RIBBON_TABS.pdf[0]).toBe("pdf");
    expect(RIBBON_TABS.pdf.filter((x) => WORD_TABS.includes(x) && x !== "view")).toEqual([]);
    const pdf = page("PDF", "pdf");
    for (const m of MODES) {
      expect(surfaceOf(pdf, m), m).toBe("pdf");
      expect(editModeOf(m, pdf), m).toBe("DOCUMENT");
    }
    expect(fixedFormatOf(pdf)).toBe("PDF");
  });
  it("CAD: a CAD tab on the drawing screen in every work mode; a plain design page once the screen is off", () => {
    expect(RIBBON_TABS.cad[0]).toBe("cad");
    const dxf = page("DESIGN", "dxf");
    dxf.source = { format: "dxf", name: "a.dxf", cad: { insunits: 4 } } as any;
    for (const m of MODES) expect(surfaceOf(dxf, m), m).toBe("cad");
    expect(fixedFormatOf(dxf)).toBe("CAD");
    useCadScreen.getState().set(false);
    expect(surfaceOf(dxf, "AUTO")).toBe("design");
    expect(fixedFormatOf(dxf)).toBeNull();
  });
  it("slides: PowerPoint's tabs; images and designs: drop-down menus over an options bar", () => {
    expect(RIBBON_TABS.slide).toEqual(["home", "insert", "design", "transitions", "animations", "show", "view"]);
    expect(surfaceOf(page("SLIDE", "pptx"), "AUTO")).toBe("slide");
    expect(surfaceOf(page("DESIGN", "psd"), "AUTO")).toBe("image");
    expect(surfaceOf(page("DESIGN", "svg"), "AUTO")).toBe("design");
    expect(RIBBON_TABS.image).toEqual(IMAGE_MENUS.map((m) => m.id));
    expect(RIBBON_TABS.design).toEqual(DESIGN_MENUS.map((m) => m.id));
  });
  it("an Illustrator / EPS file (a PDF page underneath) is a design, never the PDF tabs (QA 2026-11-21)", () => {
    for (const f of ["ai", "eps"]) {
      const ai = page("PDF", f);
      expect(isPdfFormatPage(ai), f).toBe(false);
      expect(fixedFormatOf(ai), f).toBeNull();
      expect(surfaceOf(ai, "AUTO"), f).toBe("design");
      expect(surfaceOf(ai, "IMAGE"), f).toBe("image");
    }
    expect(isPdfFormatPage(page("PDF", "pdf"))).toBe(true);
    expect(isPdfFormatPage(page("PDF"))).toBe(true);
    // the design 문자 menu and the options bar keep 텍스트 편집(승격) for them
    expect(JSON.stringify(DESIGN_MENUS.find((m) => m.id === "type")!.entries)).toContain('"text.editPdf"');
    expect(readFileSync("src/ui/shell/Ribbon.tsx", "utf8")).toMatch(/optionsBar && \(\s*<>\s*<PdfElevateBtn \/>/);
  });
  it("a work mode chosen on a PDF or a drawing says why nothing changes instead of switching silently", () => {
    const doc = newDocument();
    doc.pages = [page("PDF", "pdf")];
    S().load(doc);
    S().set({ pageId: S().doc.pages[0].id, mode: "AUTO" });
    let said = "";
    const notify = S().notify;
    useStore.setState({ notify: (m: string) => void (said = m) } as any);
    try {
      setWorkMode("SLIDE");
      expect(S().mode).toBe("AUTO");
      expect(said).toBe(t("topui.fixedTip.PDF"));
    } finally {
      useStore.setState({ notify } as any);
    }
  });
  it("other formats still follow an explicit work mode", () => {
    const docx = page("DOCUMENT", "docx");
    expect(surfaceOf(docx, "IMAGE")).toBe("image");
    expect(surfaceOf(docx, "SLIDE")).toBe("slide");
  });
  it("a tab chosen on another format falls back to the format's first tab; ctx only while there is one", () => {
    expect(activeTab("pdf", "layout", null)).toBe("pdf");
    expect(activeTab("doc", "review", null)).toBe("review");
    expect(activeTab("doc", "ctx", null)).toBe("home");
    expect(activeTab("doc", "ctx", "table")).toBe("ctx");
  });
  it("every tab and menu has a name in all four languages", () => {
    for (const lang of ["ko", "en", "zh", "ja"] as const)
      for (const s of Object.keys(RIBBON_TABS) as Surface[])
        for (const id of RIBBON_TABS[s]) expect(DICTS[lang][`topui.tab.${s}.${id}`], `${lang} ${s}.${id}`).toBeTruthy();
  });
});

describe("the tab row as drawn", () => {
  // the server renderer reads zustand's server snapshot (the store's initial state object): copy the live state into it
  const snap = () => {
    Object.assign((useStore as any).getInitialState(), useStore.getState());
    Object.assign((useCadScreen as any).getInitialState(), useCadScreen.getState());
  };
  const draw = (p: Page, mode: (typeof MODES)[number] = "AUTO") => {
    const doc = newDocument();
    doc.pages = [p];
    S().load(doc);
    S().set({ pageId: S().doc.pages[0].id, mode });
    expect(S().doc.pages[0].kind).toBe(p.kind);
    snap();
    return renderToStaticMarkup(createElement(TabRow));
  };
  it("a PDF shows 파일 · PDF · 주석 · 쪽 · 보호 · 보기 and a fixed PDF mark, never 레이아웃 / 참조", () => {
    for (const m of MODES) {
      const html = draw(page("PDF", "pdf"), m);
      expect(html, m).toContain(">PDF<");
      expect(html, m).toContain("mode-fixed");
      expect(html, m).not.toContain(">레이아웃<");
      expect(html, m).not.toContain(">참조<");
      expect(html, m).not.toContain("menubar-btn");
    }
  });
  it("a Word document shows the word processor's tabs and the five work modes", () => {
    const html = draw(page("DOCUMENT", "docx"));
    for (const name of ["파일", "홈", "삽입", "레이아웃", "참조", "검토", "보기", "그리기"]) expect(html).toContain(`>${name}<`);
    expect((html.match(/class="mode-btn/g) ?? []).length).toBe(5);
  });
  it("an image shows drop-down menus (menubar), a slide deck ▶ 발표", () => {
    expect(draw(page("DESIGN", "psd"))).toContain('role="menubar"');
    expect(draw(page("SLIDE", "pptx"))).toContain("btn-primary");
  });
});

describe("the work mode switch shrinks only when the row does not fit", () => {
  it("keeps all five modes with their names until the other details are gone, then icons, then one drop-down", () => {
    const forms = COMPACT_STEPS.map((s) => s.mode);
    expect(forms[0]).toBe("full");
    const firstIcons = forms.indexOf("icons");
    expect(COMPACT_STEPS.slice(0, firstIcons).every((s) => s.mode === "full")).toBe(true);
    expect(COMPACT_STEPS[firstIcons - 1].labels).toBe(false);
    expect(COMPACT_STEPS[firstIcons - 1].tightTabs).toBe(true);
    expect(forms.at(-1)).toBe("menu");
  });
  it("steps only while the row overflows, and stops at the last step", () => {
    expect(nextCompactStep(0, 1000, 1000)).toBe(0);
    expect(nextCompactStep(0, 1100, 1000)).toBe(1);
    let s = 0;
    for (let i = 0; i < 10; i++) s = nextCompactStep(s, 2000, 1000);
    expect(COMPACT_STEPS[s].mode).toBe("menu");
  });
});

describe("key tips (Alt / F10) do not take keys they should not", () => {
  const ev = (o: Partial<KeyboardEvent>) => ({ key: "Alt", code: "AltLeft", repeat: false, ctrlKey: false, shiftKey: false, metaKey: false, isComposing: false, keyCode: 18, ...o }) as KeyboardEvent;
  it("left Alt alone toggles them; right Alt (AltGr, the 한/영 key), IME composing and chords do not", () => {
    expect(keyTipAlt(ev({}))).toBe(true);
    expect(keyTipAlt(ev({ code: "AltRight" }))).toBe(false);
    expect(keyTipAlt(ev({ isComposing: true }))).toBe(false);
    expect(keyTipAlt(ev({ keyCode: 229 }))).toBe(false);
    expect(keyTipAlt(ev({ ctrlKey: true }))).toBe(false);
    expect(keyTipAlt(ev({ shiftKey: true }))).toBe(false);
    expect(keyTipAlt(ev({ repeat: true }))).toBe(false);
  });
  it("Alt used with the mouse is not 'alone'; letters come from the key's code (한글 mode); F10 stays polar on drawings", () => {
    const src = readFileSync("src/ui/shell/TopBar.tsx", "utf8");
    expect(src).toContain('window.addEventListener("pointerdown", pointer, true)');
    expect(src).toContain('window.addEventListener("wheel", pointer');
    expect(src).toContain("/^Key([A-Z])$/.exec(e.code)");
    expect(src).toContain('useKeyTipKeys(() => surface !== "cad")');
    // the letter shown on a tab is for the eye; screen readers get aria-keyshortcuts
    expect(src).toContain('className="keytip" aria-hidden="true"');
    expect(src).toContain("aria-keyshortcuts={`Alt+${keys[id]}`}");
  });
});

describe("the 88 px ribbon (QA 2026-11-21)", () => {
  it("a column of three small rows is drawn tighter so the group's name under it is not cut off", () => {
    const css = readFileSync("src/ui/styles.css", "utf8");
    expect(css).toContain(".rcol:has(> :nth-child(3)) {");
    expect(css).toMatch(/\.rcol:has\(> :nth-child\(3\)\) > \.rsmall,\s*\.rcol:has\(> :nth-child\(3\)\) > \.rcheck \{\s*height: calc\(22px \* var\(--ui-scale\)\);/);
  });
});

describe("the window (issue 4)", () => {
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const caps = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
  it("has no Windows title bar and stays resizable; its own buttons may minimise, maximise, close and drag", () => {
    const w = conf.app.windows[0];
    expect(w.decorations).toBe(false);
    expect(w.resizable).not.toBe(false);
    for (const p of ["core:window:allow-minimize", "core:window:allow-toggle-maximize", "core:window:allow-close", "core:window:allow-start-dragging", "core:window:allow-internal-toggle-maximize"]) expect(caps.permissions, p).toContain(p);
  });
  it("the title bar is the drag region; buttons and tabs in it are not", () => {
    const src = readFileSync("src/ui/shell/TopBar.tsx", "utf8");
    expect(src).toContain('<header className="titlebar" data-tauri-drag-region>');
    expect(src).toContain('className="title-drag" data-tauri-drag-region');
    expect(readFileSync("src/ui/shell/WindowControls.tsx", "utf8")).not.toContain("data-tauri-drag-region");
  });
});
