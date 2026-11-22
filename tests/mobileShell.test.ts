// Phone shell helpers (docs/MOBILE_PLAN.md): names of picked Android URIs, the recent list, the language files.
import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import { displayName } from "../src/io/platform";
import { addRecent, type RecentItem } from "../src/ui/mobile/recent";

describe("mobile shell", () => {
  it("names a picked file from a path or an Android document URI", () => {
    expect(displayName("C:\\Users\\u\\계약서.pdf")).toBe("계약서.pdf");
    expect(displayName("/home/u/a.docx")).toBe("a.docx");
    expect(displayName("content://com.android.externalstorage.documents/document/primary%3ADownload%2F%EA%B3%84%EC%95%BD%EC%84%9C.pdf")).toBe("계약서.pdf");
    expect(displayName("content://com.android.providers.downloads.documents/document/msf%3A31")).toBe("31");
    expect(displayName("file:///data/user/0/x/cache/scan.pdf")).toBe("scan.pdf");
  });

  it("keeps the recent list short, newest first, one entry per file, names only", () => {
    let list: RecentItem[] = [];
    for (let i = 0; i < 40; i++) list = addRecent({ name: `f${i}.pdf`, size: i, path: null, at: i }, list);
    expect(list.length).toBe(30);
    expect(list[0].name).toBe("f39.pdf");
    list = addRecent({ name: "f20.pdf", size: 1, path: null, at: 99 }, list);
    expect(list.filter((x) => x.name === "f20.pdf").length).toBe(1);
    expect(list[0].at).toBe(99);
    expect(Object.keys(list[0]).sort()).toEqual(["at", "name", "path", "size"]);
  });

  it("keeps the updater and window buttons off the phone app", () => {
    const desk = JSON.parse(readFileSync("src-tauri/capabilities/desktop.json", "utf8"));
    const all = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
    expect(desk.platforms.sort()).toEqual(["linux", "macOS", "windows"]);
    expect(desk.permissions).toContain("updater:default");
    expect(JSON.stringify(all.permissions)).not.toMatch(/updater|process|core:window/);
    const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
    const desktopOnly = cargo.slice(cargo.indexOf(`[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]`));
    expect(desktopOnly).toContain("tauri-plugin-updater");
    expect(cargo.slice(0, cargo.indexOf("[target."))).not.toContain("tauri-plugin-updater");
  });

  it("has every phone string in all four languages", () => {
    const read = (l: string) => JSON.parse(readFileSync(`src/i18n/parts/mobile/${l}.json`, "utf8")) as Record<string, string>;
    const ko = Object.keys(read("ko")).sort();
    for (const l of ["en", "ja", "zh"]) expect(Object.keys(read(l)).sort()).toEqual(ko);
    expect(read("ko")["mobile.noUpload"]).toBe("파일은 이 휴대폰에서만 처리됩니다");
  });
});
