// Windows "Open with" (src-tauri/windows/open-with.json): the NSIS hooks, the MSIX manifest and the open formats
// stay in step, and nothing takes a default program away.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FORMATS } from "../src/io/formats";
// @ts-expect-error plain .mjs script, no types
import { BEGIN, END, HOOKS_PATH, nshSection, readSpec, registryEntries, withSection } from "../scripts/open-with.mjs";

interface ProgId {
  id: string;
  msix: string;
  en: string;
  ko: string;
  exts: string[];
}
const spec: { progIds: ProgId[]; notListed: Record<string, string> } = readSpec();
const listed = spec.progIds.flatMap((p) => p.exts);

describe("open-with list", () => {
  it("every extension Omniweave opens is listed, or left out on purpose", () => {
    const missing = FORMATS.filter((f) => f.open && !spec.notListed[f.id]).flatMap((f) => f.exts).filter((e) => !listed.includes(e) && !spec.notListed[e]);
    expect(missing).toEqual([]);
  });
  it("lists only extensions Omniweave opens, each once, lower case", () => {
    const openable = FORMATS.filter((f) => f.open).flatMap((f) => f.exts);
    expect(listed.filter((e) => !openable.includes(e))).toEqual([]);
    expect(new Set(listed).size).toBe(listed.length);
    for (const e of listed) expect(e).toMatch(/^[a-z0-9]+$/);
    // the main formats are there
    for (const e of ["docx", "doc", "hwpx", "hwp", "pptx", "ppt", "xlsx", "xls", "csv", "pdf", "psd", "psb", "ai", "svg", "dwg", "dxf", "png", "jpg", "jpeg", "webp", "gif", "bmp", "tiff", "epub", "md", "txt"]) expect(listed).toContain(e);
    // .omw is Omniweave's own type, registered (and made the default) by Tauri's bundle.fileAssociations
    expect(listed).not.toContain("omw");
  });
  it("Tauri's fileAssociations (which may set the default program) hold only .omw", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.bundle.fileAssociations.flatMap((a: { ext: string[] }) => a.ext)).toEqual(["omw"]);
    expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
    expect(conf.bundle.windows.nsis.installerHooks).toBe("./windows/installer-hooks.nsh");
  });
});

describe("NSIS hooks", () => {
  const hooks = readFileSync(HOOKS_PATH, "utf8");
  it("installer-hooks.nsh holds the generated part, up to date (node scripts/open-with.mjs)", () => {
    expect(withSection(hooks, spec)).toBe(hooks);
    expect(hooks.startsWith("﻿")).toBe(true); // makensis reads the Korean names as UTF-8
    expect(hooks).toMatch(/!macro NSIS_HOOK_POSTINSTALL[\s\S]*?!insertmacro OMW_OPEN_WITH_REGISTER[\s\S]*?!macroend/);
    expect(hooks).toMatch(/!macro NSIS_HOOK_POSTUNINSTALL[\s\S]*?!insertmacro OMW_OPEN_WITH_UNREGISTER[\s\S]*?!macroend/);
  });
  it("writes only HKCU, never an extension's default value or UserChoice", () => {
    const sec = nshSection(spec);
    expect(sec.startsWith(BEGIN) && sec.endsWith(END)).toBe(true);
    const writes = sec.split("\r\n").filter((l: string) => /WriteReg/.test(l));
    expect(writes.length).toBeGreaterThan(0);
    for (const l of writes) expect(l).toMatch(/^\s*WriteRegStr HKCU "Software\\Classes\\/);
    expect(sec).not.toMatch(/HKLM|SHCTX|UserChoice|FileExts/);
    for (const [key, name] of registryEntries(spec) as [string, string, unknown][]) {
      // a ".ext" key is only ever given an OpenWithProgids value, never its default (that would take the default app)
      if (/^Software\\Classes\\\.[a-z0-9]+(\\|$)/.test(key)) {
        expect(key).toMatch(/^Software\\Classes\\\.[a-z0-9]+\\OpenWithProgids$/);
        expect(name).toMatch(/^Omniweave\.[A-Za-z]+$/);
      }
    }
  });
  it("registers the app, each type and each extension; the uninstaller removes the same", () => {
    const e = registryEntries(spec) as [string, string, unknown][];
    const app = "Software\\Classes\\Applications\\${MAINBINARYNAME}.exe";
    const open = '$\\"$INSTDIR\\${MAINBINARYNAME}.exe$\\" $\\"%1$\\"';
    expect(e).toContainEqual([app, "FriendlyAppName", "${PRODUCTNAME}"]);
    expect(e).toContainEqual([app + "\\shell\\open\\command", "", open]);
    for (const p of spec.progIds) {
      expect(p.id).toMatch(/^Omniweave\.[A-Za-z]+$/);
      expect(e).toContainEqual(["Software\\Classes\\" + p.id, "", { en: p.en, ko: p.ko }]);
      expect(e).toContainEqual(["Software\\Classes\\" + p.id + "\\shell\\open\\command", "", open]);
      for (const x of p.exts) {
        expect(e).toContainEqual([app + "\\SupportedTypes", "." + x, ""]);
        expect(e).toContainEqual([`Software\\Classes\\.${x}\\OpenWithProgids`, p.id, ""]);
      }
    }
    const sec: string = nshSection(spec);
    const un = sec.slice(sec.indexOf("!macro OMW_OPEN_WITH_UNREGISTER"));
    expect(un).toContain(`DeleteRegKey HKCU "${app}"`);
    for (const p of spec.progIds) {
      expect(un).toContain(`DeleteRegKey HKCU "Software\\Classes\\${p.id}"`);
      for (const x of p.exts) {
        expect(un).toContain(`DeleteRegValue HKCU "Software\\Classes\\.${x}\\OpenWithProgids" "${p.id}"`);
        // an extension key goes only when empty: other programs' entries stay
        expect(un).not.toMatch(new RegExp(`DeleteRegKey HKCU "Software\\\\Classes\\\\\\.${x}"`));
      }
    }
    // Explorer is told both times
    expect(sec.match(/SHChangeNotify\(i 0x08000000/g)?.length).toBe(2);
  });
});

describe("MSIX manifest", () => {
  const xml = readFileSync("packaging/msix/AppxManifest.template.xml", "utf8");
  const group = (name: string) => {
    const m = xml.match(new RegExp(`<uap:FileTypeAssociation Name="${name.replace(".", "\\.")}">([\\s\\S]*?)</uap:FileTypeAssociation>`));
    return [...(m?.[1] ?? "").matchAll(/<uap:FileType[^>]*>\.([a-z0-9]+)<\/uap:FileType>/g)].map((x) => x[1]);
  };
  it("declares the same types as the installer (MSIX never takes the default program)", () => {
    for (const name of new Set(spec.progIds.map((p) => p.msix))) {
      expect(group(name).sort()).toEqual(spec.progIds.filter((p) => p.msix === name).flatMap((p) => p.exts).sort());
    }
    expect(group("omniweave.workspace")).toEqual(["omw"]);
  });
});
