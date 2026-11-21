// The key table (src/ui/keymap.ts, docs/qa/parity/SHORTCUTS.md): in every key context no key is bound to two
// commands, a context row that takes a common key says so, no row takes a key Windows or the browser keeps, and the
// keys the hands bring from each program reach the command they mean there.
import { beforeEach, describe, expect, it } from "vitest";
import { useStore, type Mode } from "../src/core/store";
import { newDocument, newPage, type Page, type PageKind } from "../src/core/types";
import { BINDINGS, BROWSER_RESERVED, KEY_CONTEXTS, OS_RESERVED, chordOf, kbdFor, keyContext, keyContextOf, keymapFor, normChord, resolveKey, type Binding, type KeyContext } from "../src/ui/keymap";
import { COMMANDS, command } from "../src/ui/commands";
import { PROFILES } from "../src/ui/editModes";

const S = () => useStore.getState();

function pageOf(kind: PageKind, format?: string, extra: Partial<Page> = {}): Page {
  const p = newPage(kind, 800, 600, "P");
  if (format) p.source = { format } as Page["source"];
  return Object.assign(p, extra);
}

function load(p: Page, mode: Mode = "AUTO") {
  const doc = newDocument("t");
  doc.pages = [p];
  S().load(doc);
  S().set({ mode, pageId: p.id });
}

const applies = (b: Binding, ctx: KeyContext) => (!b.in || b.in.includes(ctx)) && !b.except?.includes(ctx);

describe("the whole key table", () => {
  it("in every context no chord is bound to two commands (a context row may only replace a common row it names)", () => {
    const bad: string[] = [];
    for (const ctx of KEY_CONTEXTS) {
      const by = new Map<string, Binding[]>();
      for (const b of BINDINGS) if (applies(b, ctx)) by.set(normChord(b.keys), [...(by.get(normChord(b.keys)) ?? []), b]);
      for (const [chord, rows] of by) {
        const common = rows.filter((b) => !b.in);
        const own = rows.filter((b) => b.in);
        if (common.length > 1) bad.push(`${ctx} ${chord}: common ${common.map((b) => b.cmd).join(" / ")}`);
        if (own.length > 1) bad.push(`${ctx} ${chord}: ${own.map((b) => b.cmd).join(" / ")}`);
        if (own.length && common.length && own[0].cmd !== common[0].cmd && own[0].replaces !== common[0].cmd)
          bad.push(`${ctx} ${chord}: ${own[0].cmd} silently takes ${common[0].cmd}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every `replaces` names the common row it really pushes aside", () => {
    for (const b of BINDINGS.filter((x) => x.replaces)) {
      const common = BINDINGS.find((c) => !c.in && normChord(c.keys) === normChord(b.keys));
      expect(common?.cmd, `${b.keys} ${b.cmd}`).toBe(b.replaces);
    }
  });

  it("every row names a real command (or a mode's own key action, act.*)", () => {
    const missing = BINDINGS.filter((b) => !b.cmd.startsWith("act.") && !command(b.cmd)).map((b) => `${b.keys} → ${b.cmd}`);
    expect(missing).toEqual([]);
  });

  it("no row takes a key Windows keeps; keys a browser keeps are desktop-only rows", () => {
    const os = new Set(OS_RESERVED.map(normChord));
    const web = new Set(BROWSER_RESERVED.map(normChord));
    expect(BINDINGS.filter((b) => os.has(normChord(b.keys))).map((b) => b.keys)).toEqual([]);
    expect(BINDINGS.filter((b) => web.has(normChord(b.keys)) && !b.desktop).map((b) => `${b.keys} ${b.cmd}`)).toEqual([]);
  });

  it("the shown key of a command runs that command in the same context", () => {
    const bad: string[] = [];
    for (const ctx of KEY_CONTEXTS)
      for (const c of COMMANDS) {
        const k = kbdFor(c.id, ctx);
        if (k && resolveKey(ctx, k) !== c.id) bad.push(`${ctx} ${c.id} ${k}`);
      }
    expect(bad).toEqual([]);
  });

  it("the tool letters of the image and design profiles are rows of the table, and nowhere else", () => {
    for (const mode of ["IMAGE", "DESIGN"] as const) {
      const m = keymapFor(mode);
      for (const k of Object.keys(PROFILES[mode].keys)) {
        const chord = k.startsWith("shift+") ? `Shift+${k.slice(6)}` : k === "~" ? "Shift+`" : k === "+" ? "Shift+=" : k;
        expect(m.get(normChord(chord)), `${mode} ${k}`).toBeTruthy();
      }
    }
    for (const ctx of ["WORD", "HWP", "PDF", "SLIDE", "SHEET", "CAD"] as const) for (const l of "TRMLPBEVAUC") expect(resolveKey(ctx, l), `${ctx} ${l}`).toBeUndefined();
  });

  it("an app command has the same key in every context (command search, settings, shortcut list)", () => {
    for (const ctx of KEY_CONTEXTS) {
      expect(resolveKey(ctx, "Alt+Q")).toBe("tools.commandSearch");
      expect(resolveKey(ctx, "Ctrl+,")).toBe("file.settings");
      expect(resolveKey(ctx, "F1")).toBe("help.shortcuts");
      expect(resolveKey(ctx, "Ctrl+S")).toBe("file.save");
    }
  });
});

describe("the keys each program's users press go where they mean", () => {
  const cases: [KeyContext, string, string | undefined][] = [
    // Ctrl+K: hyperlink (not here yet) in Word / 한글 / PowerPoint / Excel / AutoCAD, preferences in Photoshop / Illustrator / Acrobat
    ["WORD", "Ctrl+K", "act.linkMissing"],
    ["HWP", "Ctrl+K", "act.linkMissing"],
    ["SLIDE", "Ctrl+K", "act.linkMissing"],
    ["SHEET", "Ctrl+K", "act.linkMissing"],
    ["CAD", "Ctrl+K", "act.linkMissing"],
    ["IMAGE", "Ctrl+K", "file.settings"],
    ["DESIGN", "Ctrl+K", "file.settings"],
    ["PDF", "Ctrl+K", "file.settings"],
    // F5: the show from the first slide (PowerPoint), Shift+F5 from this one; Word's F5 (이동) is not a slide show
    ["SLIDE", "F5", "slide.showFromStart"],
    ["SLIDE", "Shift+F5", "slide.showFromCurrent"],
    ["DESIGN", "F5", "slide.showFromCurrent"],
    ["WORD", "F5", undefined],
    ["HWP", "F5", undefined],
    ["IMAGE", "F5", undefined],
    // F7: Word spelling, 한글 편집 용지, Photoshop / Illustrator layers, AutoCAD grid; 한글 spelling is F8
    ["WORD", "F7", "review.spelling"],
    ["HWP", "F7", "page.setup"],
    ["HWP", "F8", "review.spelling"],
    ["IMAGE", "F7", "view.layersPanel"],
    ["DESIGN", "F7", "view.layersPanel"],
    ["CAD", "F7", "act.cad.grid"],
    ["CAD", "F8", "act.cad.ortho"],
    // 한글 Alt keys
    ["HWP", "Alt+S", "file.save"],
    ["HWP", "Alt+V", "file.saveAs"],
    ["HWP", "Alt+O", "file.open"],
    ["HWP", "Alt+N", "file.new"],
    ["HWP", "Alt+P", "file.print"],
    ["HWP", "Alt+T", "format.paragraph"],
    ["HWP", "Alt+L", undefined],
    ["HWP", "Ctrl+F10", "insert.symbol"],
    ["WORD", "Alt+S", undefined],
    // Word
    ["WORD", "F12", "file.saveAs"],
    ["WORD", "Ctrl+Enter", "insert.pageBreak"],
    ["WORD", "Ctrl+Alt+1", "act.doc.heading1"],
    ["WORD", "Ctrl+D", undefined],
    ["WORD", "Ctrl+J", undefined],
    ["WORD", "Ctrl+T", undefined],
    ["WORD", "Ctrl+Shift+N", undefined],
    ["WORD", "Ctrl+G", undefined],
    // PowerPoint
    ["SLIDE", "Ctrl+M", "slide.new"],
    ["SLIDE", "Ctrl+D", "edit.duplicate"],
    ["SLIDE", "Ctrl+G", "image.groupLayers"],
    ["SLIDE", "Ctrl+T", undefined],
    ["SLIDE", "Alt+F9", "view.guides"],
    ["SLIDE", "Ctrl+Enter", undefined],
    // Photoshop
    ["IMAGE", "Ctrl+D", "act.pixel.deselect"],
    ["IMAGE", "Ctrl+J", "image.duplicateLayer"],
    ["IMAGE", "Ctrl+T", "object.transform"],
    ["IMAGE", "Ctrl+A", "act.pixel.selectAll"],
    ["IMAGE", "U", "insert.rect"],
    ["IMAGE", "M", "act.tool.marquee"],
    ["IMAGE", "Ctrl+Alt+1", "view.leftDock"],
    ["IMAGE", "Ctrl+E", "image.mergeDown"],
    ["DESIGN", "Ctrl+7", "image.clippingMask"],
    // Acrobat: Ctrl+Shift+N is 쪽 이동 — never a new layer on a PDF page
    ["PDF", "Ctrl+Shift+N", undefined],
    // Illustrator
    ["DESIGN", "Ctrl+J", "act.path.join"],
    ["DESIGN", "Ctrl+Y", "act.design.outline"],
    ["DESIGN", "Ctrl+Alt+2", "act.design.unlockAll"],
    ["DESIGN", "M", "insert.rect"],
    ["DESIGN", "L", "insert.ellipse"],
    ["DESIGN", "Shift+E", "image.eraser"],
    // Excel
    ["SHEET", "Ctrl+Shift+1", "sheet.fmt.number"],
    ["SHEET", "Ctrl+PgDn", "sheet.next"],
    ["SHEET", "Ctrl+D", "act.sheet.fillDown"],
    ["SHEET", "Ctrl+;", "act.sheet.today"],
    ["WORD", "Ctrl+Shift+1", "mode.AUTO"],
    ["WORD", "Ctrl+PgDn", "view.nextTab"],
    // AutoCAD
    ["CAD", "Ctrl+1", "act.cad.properties"],
    ["CAD", "M", undefined],
  ];
  it.each(cases)("%s %s → %s", (ctx, keys, want) => {
    expect(resolveKey(ctx, keys)).toBe(want);
  });
});

describe("key contexts", () => {
  it("follow the page's file and the work mode", () => {
    expect(keyContextOf("AUTO", pageOf("DOCUMENT", "docx"), { cad: false })).toBe("WORD");
    expect(keyContextOf("AUTO", pageOf("DOCUMENT"), { cad: false })).toBe("WORD");
    expect(keyContextOf("AUTO", pageOf("DOCUMENT", "hwpx"), { cad: false })).toBe("HWP");
    expect(keyContextOf("AUTO", pageOf("DOCUMENT", "hwp"), { cad: false })).toBe("HWP");
    expect(keyContextOf("AUTO", pageOf("PDF", "pdf"), { cad: false })).toBe("PDF");
    expect(keyContextOf("AUTO", pageOf("SLIDE", "pptx"), { cad: false })).toBe("SLIDE");
    expect(keyContextOf("AUTO", pageOf("DESIGN", "psd"), { cad: false })).toBe("IMAGE");
    expect(keyContextOf("AUTO", pageOf("DESIGN", "svg"), { cad: false })).toBe("DESIGN");
    expect(keyContextOf("AUTO", pageOf("DOCUMENT", "xlsx"), { cad: false, sheet: true })).toBe("SHEET");
    expect(keyContextOf("DESIGN", pageOf("DOCUMENT", "dxf"), { cad: true })).toBe("CAD");
    // an explicit work mode re-targets the keys too
    expect(keyContextOf("IMAGE", pageOf("DOCUMENT", "docx"), { cad: false })).toBe("IMAGE");
    expect(keyContextOf("DOCUMENT", pageOf("SLIDE", "pptx"), { cad: false })).toBe("WORD");
  });

  it("the current page's context drives the keys shown in menus, command search and the shortcut list", () => {
    load(pageOf("DOCUMENT", "docx"));
    expect(keyContext()).toBe("WORD");
    expect(command("tools.commandSearch")!.kbd).toBe("Alt+Q");
    expect(command("review.spelling")!.kbd).toBe("F7");
    expect(command("insert.text")!.kbd).toBeUndefined();
    expect(command("edit.duplicate")!.kbd).toBeUndefined();
    expect(command("slide.showFromStart")!.kbd).toBeUndefined();

    load(pageOf("DOCUMENT", "hwpx"));
    expect(keyContext()).toBe("HWP");
    expect(command("page.setup")!.kbd).toBe("F7");
    expect(command("format.paragraph")!.kbd).toBe("Alt+T");
    expect(command("file.save")!.kbd).toBe("Ctrl+S");

    load(pageOf("SLIDE", "pptx"));
    expect(command("slide.showFromStart")!.kbd).toBe("F5");
    expect(command("slide.showFromCurrent")!.kbd).toBe("Shift+F5");
    expect(command("slide.new")!.kbd).toBe("Ctrl+M");

    load(pageOf("DESIGN", "psd"));
    expect(keyContext()).toBe("IMAGE");
    expect(command("insert.rect")!.kbd).toBe("U");
    expect(command("insert.text")!.kbd).toBe("T");
    expect(command("file.settings")!.kbd).toBe("Ctrl+,");

    // the shortcut list has no key twice
    const kbds = COMMANDS.map((c) => c.kbd).filter(Boolean);
    expect(new Set(kbds).size).toBe(kbds.length);
  });
});

describe("chords of key presses", () => {
  const ev = (key: string, code: string, m: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {}) => ({ key, code, ctrlKey: !!m.ctrl, metaKey: false, altKey: !!m.alt, shiftKey: !!m.shift });
  it("letters by character on Latin layouts, by position under the Korean IME; digits and punctuation by position", () => {
    expect(chordOf(ev("q", "KeyQ", { alt: true }))).toBe("Alt+Q");
    expect(chordOf(ev("ㅂ", "KeyQ", { alt: true }))).toBe("Alt+Q");
    expect(chordOf(ev("Process", "KeyS", { alt: true }))).toBe("Alt+S");
    expect(chordOf(ev("!", "Digit1", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+1");
    expect(chordOf(ev("}", "BracketRight", { ctrl: true, shift: true }))).toBe("Ctrl+Shift+]");
    expect(chordOf(ev("F5", "F5", { shift: true }))).toBe("Shift+F5");
    expect(chordOf(ev("PageDown", "PageDown", { ctrl: true }))).toBe("Ctrl+PgDn");
    expect(chordOf(ev("~", "Backquote", { shift: true }))).toBe("Shift+`");
    expect(normChord("shift+ctrl+s")).toBe("Ctrl+Shift+S");
  });
});

beforeEach(() => {
  S().set({ mode: "AUTO" });
});
