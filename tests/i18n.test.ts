// Language files stay in step, and every menu / command has a label in each of them.
import { afterEach, describe, expect, it } from "vitest";
import { DICTS, DUPLICATE_KEYS, LANGS, langFromTag, t, useLang } from "../src/i18n";
import { allCommands, commandLabel, COMMANDS } from "../src/ui/commands";
import { menuCommandIds, MENUS } from "../src/ui/menus";
import { matchCommands } from "../src/ui/shell/ShellDialogs";

afterEach(() => useLang.getState().set("ko"));

describe("i18n", () => {
  it("ko / en / zh / ja have exactly the same keys and no empty text", () => {
    const ko = Object.keys(DICTS.ko).sort();
    for (const l of LANGS) {
      expect(Object.keys(DICTS[l.id]).sort(), l.id).toEqual(ko);
      for (const [k, v] of Object.entries(DICTS[l.id])) expect(v.trim(), `${l.id} ${k}`).not.toBe("");
    }
  });

  it("each key is defined in one language file only", () => {
    expect(DUPLICATE_KEYS).toEqual([]);
  });

  it("placeholders match across languages", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join();
    for (const k of Object.keys(DICTS.ko)) for (const l of LANGS) expect(ph(DICTS[l.id][k]), `${l.id} ${k}`).toBe(ph(DICTS.ko[k]));
  });

  it("other languages are really translated (not Korean left in place)", () => {
    const hangul = /[가-힣]/;
    // the company's legal name is written in Korean on purpose
    for (const l of ["en", "zh", "ja"] as const)
      for (const [k, v] of Object.entries(DICTS[l])) expect(hangul.test(v), `${l} ${k}: ${v}`).toBe(false);
  });

  it("every menu and command has a label; menus only name registered commands", () => {
    for (const m of MENUS) expect(DICTS.ko[`menu.${m.id}`], m.id).toBeTruthy();
    const ids = new Set(allCommands().map((c) => c.id).concat(COMMANDS.map((c) => c.id)));
    for (const id of menuCommandIds()) expect(ids.has(id), id).toBe(true);
    // generated commands (내보내기 ▸ PDF) carry their own label
    for (const c of allCommands()) expect(c.label?.() ?? DICTS.ko[`cmd.${c.id}`] ?? DICTS.ko[c.id], c.id).toBeTruthy();
    expect(new Set(COMMANDS.map((c) => c.id)).size).toBe(COMMANDS.length);
  });

  it("switching language changes labels at once; unknown keys fall back", () => {
    useLang.getState().set("en");
    expect(t("menu.file")).toBe("File");
    expect(commandLabel(COMMANDS.find((c) => c.id === "file.saveAs")!)).toBe("Save As…");
    useLang.getState().set("ja");
    expect(t("menu.file")).toBe("ファイル");
    expect(t("about.version", { version: "1.2.3" })).toContain("1.2.3");
    expect(t("no.such.key", undefined, "대체")).toBe("대체");
  });

  it("OS / browser language tags map to a supported language", () => {
    expect(langFromTag("en-US")).toBe("en");
    expect(langFromTag("zh-CN")).toBe("zh");
    expect(langFromTag("ja-JP")).toBe("ja");
    expect(langFromTag("ko-KR")).toBe("ko");
    expect(langFromTag("fr-FR")).toBe("ko");
  });

  it("command search finds by label (any language) and by shortcut", () => {
    const all = allCommands();
    expect(matchCommands(all, "다른 이름")[0].id).toBe("file.saveAs");
    expect(matchCommands(all, "alt+q")[0].id).toBe("tools.commandSearch");
    useLang.getState().set("en");
    expect(matchCommands(all, "save as")[0].id).toBe("file.saveAs");
  });
});
