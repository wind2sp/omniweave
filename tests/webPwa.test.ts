// Web app as an installable app (PWA): manifest, icons, service worker build and registration rules, install hint,
// iPhone file open / share. The browser checks (install criteria, offline start) are in docs/qa ??this is the logic.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { precacheList, splashLink, swSource, webPwa, WEB_DIR } from "../scripts/web-pwa.mjs";
import { shouldRegisterSW, type SwEnv } from "../src/web/pwa";
import { isAndroid, isIOS, isInAppBrowser } from "../src/web/device";
import { installHintKind } from "../src/ui/shell/WebInstall";
import { mimeFor, shareFile } from "../src/io/platform";
import { DICTS } from "../src/i18n";

const manifest = JSON.parse(readFileSync(join(WEB_DIR, "manifest.webmanifest"), "utf8"));

describe("web app manifest", () => {
  it("is installable: name, standalone, start_url / scope inside the app folder, 192 + 512 + maskable icons", () => {
    expect(manifest.name).toBe("Omniweave");
    expect(manifest.short_name.length).toBeLessThanOrEqual(12); // fits under a home-screen icon
    expect(manifest.lang).toBe("en");
    expect(manifest.display).toBe("standalone");
    // relative: resolved against the manifest's own URL, so /omniweave/app/ on Pages and any other folder
    expect(manifest.start_url).toBe("./");
    expect(manifest.scope).toBe("./");
    expect(manifest.id).toBe("./");
    expect(manifest.background_color).toBe("#151618");
    const sizes = manifest.icons.map((i: any) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(["192x192:any", "512x512:any", "512x512:maskable"]));
    for (const i of manifest.icons) expect(existsSync(join(WEB_DIR, i.src)), i.src).toBe(true);
  });

  it("opens the app's own formats when installed (file_handlers ??launchQueue)", () => {
    const exts = Object.values(manifest.file_handlers[0].accept).flat();
    for (const e of [".omw", ".pdf", ".docx", ".hwpx", ".pptx", ".psd"]) expect(exts).toContain(e);
    expect(manifest.launch_handler.client_mode).toBe("focus-existing"); // never reload over unsaved work
  });

  it("iOS icons and start-up images are there", () => {
    for (const f of ["apple-touch-icon.png", "icon-192.png", "icon-512.png", "maskable-512.png", "splash-1179x2556-3x.png", "splash-750x1334-2x.png"])
      expect(existsSync(join(WEB_DIR, "icons", f)), f).toBe(true);
    expect(splashLink("splash-1179x2556-3x.png")).toEqual({
      href: "icons/splash-1179x2556-3x.png",
      media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)",
    });
    expect(splashLink("icon-192.png")).toBeNull();
  });
});

describe("service worker build", () => {
  it("installs the app shell, not the AI models, start-up images or the update files", () => {
    const list = precacheList([
      "index.html",
      "sw.js",
      "version.json",
      "assets\\index-ABC.js",
      "assets/index-x.css",
      "assets/u2netp-Q.lwt",
      "models/ocr/rec.lwt",
      "models/sr/LICENSE",
      "fonts/Pretendard-Medium.woff2",
      "fonts/OFL.txt",
      "pdfjs/cmaps.pack",
      "icons/icon-192.png",
      "icons/splash-750x1334-2x.png",
      "manifest.webmanifest",
      "fonts/Pretendard-Medium.woff2",
    ]);
    expect(list).toEqual(["assets/index-ABC.js", "assets/index-x.css", "fonts/Pretendard-Medium.woff2", "icons/icon-192.png", "manifest.webmanifest", "pdfjs/cmaps.pack"]);
  });

  it("fills the template and stays valid JavaScript", () => {
    const tpl = readFileSync(join(WEB_DIR, "sw.js"), "utf8");
    const src = swSource(tpl, "index-ABC.js", ["assets/index-ABC.js"], "m123");
    expect(src).toContain('const BUILD = "index-ABC.js"');
    expect(src).toContain('const PRECACHE = ["assets/index-ABC.js"]');
    expect(src).toContain('const MODELS = "m123"');
    expect(() => new Function(src)).not.toThrow();
    // the policy the update flow relies on: updates wait for the page, which hands over with SKIP_WAITING
    expect(src).toContain("SKIP_WAITING");
    expect(src).toMatch(/if \(!self\.registration\.active\) self\.skipWaiting\(\)/);
    expect(src).toContain('path === "version.json"'); // never cached
    expect(() => swSource("const X = 1;", "b", [], "m")).not.toThrow();
    expect(() => swSource('const BUILD = "__OMW_BUILD__"; const MODELS = "__OMW_MODELS__X";', "b", [], "m")).toThrow();
  });

  it("is only part of the web build (OMW_WEB=1): the desktop build gets none of it", () => {
    const off = webPwa(false) as any;
    const on = webPwa(true) as any;
    expect(off.apply({}, { command: "build" })).toBe(false);
    expect(on.apply({}, { command: "build" })).toBe(true);
  });

  it("the web build emits manifest, icons and sw.js for its entry script, and links them in index.html", () => {
    const p = webPwa(true) as any;
    p.configResolved({ publicDir: join(WEB_DIR, "..", "..", "public") });
    const emitted: any[] = [];
    p.generateBundle.call(
      { emitFile: (f: any) => emitted.push(f) },
      {},
      {
        "assets/index-ABC.js": { type: "chunk", isEntry: true, name: "index", fileName: "assets/index-ABC.js" },
        "assets/u2netp-Q.lwt": { type: "asset", fileName: "assets/u2netp-Q.lwt" },
      },
    );
    const names = emitted.map((f) => f.fileName);
    expect(names).toEqual(expect.arrayContaining(["manifest.webmanifest", "icons/apple-touch-icon.png", "icons/maskable-512.png", "sw.js"]));
    const sw = emitted.find((f) => f.fileName === "sw.js").source as string;
    expect(sw).toContain('const BUILD = "index-ABC.js"');
    expect(sw).toContain('"assets/index-ABC.js"');
    expect(sw).toContain('"app_small.png"');
    expect(sw).not.toContain("u2netp-Q.lwt");
    const tags = p.transformIndexHtml().map((t: any) => `${t.tag}:${t.attrs.rel ?? t.attrs.name}`);
    expect(tags).toEqual(
      expect.arrayContaining(["link:manifest", "link:apple-touch-icon", "meta:apple-mobile-web-app-capable", "meta:apple-mobile-web-app-status-bar-style", "link:apple-touch-startup-image"]),
    );
  });
});

describe("service worker registration", () => {
  const web: SwEnv = { tauri: false, prod: true, hasSW: true, secure: true, webBuild: true };
  it("registers in the browser's web build only", () => {
    expect(shouldRegisterSW(web)).toBe(true);
    expect(shouldRegisterSW({ ...web, tauri: true })).toBe(false); // desktop app (WebView2)
    expect(shouldRegisterSW({ ...web, prod: false })).toBe(false); // dev server
    expect(shouldRegisterSW({ ...web, secure: false })).toBe(false); // plain http on a LAN address
    expect(shouldRegisterSW({ ...web, webBuild: false })).toBe(false); // build without sw.js (desktop dist served)
    expect(shouldRegisterSW({ ...web, hasSW: false })).toBe(false);
  });
});

describe("devices and the add-to-home-screen hint", () => {
  const iphone = { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1" };
  const ipad = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", platform: "MacIntel", maxTouchPoints: 5 };
  const mac = { ...ipad, maxTouchPoints: 0 };
  const android = { userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36" };
  const kakao = { userAgent: iphone.userAgent + " KAKAOTALK 10.8.0" };

  it("tells iPhone / iPad (desktop-mode iPadOS too) from a Mac, Android, in-app browsers", () => {
    expect(isIOS(iphone)).toBe(true);
    expect(isIOS(ipad)).toBe(true);
    expect(isIOS(mac)).toBe(false);
    expect(isAndroid(android)).toBe(true);
    expect(isAndroid(iphone)).toBe(false);
    expect(isInAppBrowser(kakao)).toBe(true);
    expect(isInAppBrowser(iphone)).toBe(false);
  });

  const base = { tauri: false, standalone: false, seen: false, ios: false, android: false, inApp: false, canInstall: false };
  it("iPhone Safari: the Share ??Add to Home Screen card, once, not in the home-screen app", () => {
    expect(installHintKind({ ...base, ios: true })).toBe("ios");
    expect(installHintKind({ ...base, ios: true, standalone: true })).toBeNull();
    expect(installHintKind({ ...base, ios: true, seen: true })).toBeNull();
    expect(installHintKind({ ...base, ios: true, inApp: true })).toBeNull(); // KakaoTalk etc. cannot add it
  });

  it("Android: an Install button only when the browser offers it; desktop and Tauri never", () => {
    expect(installHintKind({ ...base, android: true })).toBeNull();
    expect(installHintKind({ ...base, android: true, canInstall: true })).toBe("install");
    expect(installHintKind({ ...base, canInstall: true })).toBeNull(); // desktop Chrome: its own address-bar offer
    expect(installHintKind({ ...base, tauri: true, ios: true })).toBeNull();
  });

  it("strings in every language", () => {
    const keys = ["web.install.iosTitle", "web.install.iosShare", "web.install.iosAdd", "web.install.title", "web.install.text", "web.install.button", "web.install.close", "web.mobile.iosMemory"];
    for (const k of keys) for (const l of ["ko", "en", "zh", "ja"] as const) expect(DICTS[l][k], `${l} ${k}`).toBeTruthy();
  });
});

describe("saving on iPhone: the share sheet", () => {
  const fakeNav = (opts: { can?: boolean; fail?: string }) => {
    const shared: any[] = [];
    return {
      shared,
      canShare: () => opts.can ?? true,
      share: async (d: any) => {
        if (opts.fail) throw Object.assign(new Error("x"), { name: opts.fail });
        shared.push(d);
      },
    };
  };

  it("shares the file with its media type; cancel is a cancel; a refusal falls back to a download", async () => {
    const n = fakeNav({});
    expect(await shareFile("report.pdf", new Uint8Array([1, 2]), n)).toBe("shared");
    expect(n.shared[0].files[0].name).toBe("report.pdf");
    expect(n.shared[0].files[0].type).toBe("application/pdf");
    expect(await shareFile("a.omw", new Uint8Array([1]), fakeNav({ fail: "AbortError" }))).toBe("cancelled");
    expect(await shareFile("a.omw", new Uint8Array([1]), fakeNav({ fail: "NotAllowedError" }))).toBe("unsupported");
    expect(await shareFile("a.omw", new Uint8Array([1]), fakeNav({ can: false }))).toBe("unsupported");
    expect(await shareFile("a.omw", new Uint8Array([1]), {})).toBe("unsupported");
    expect(mimeFor("x.DOCX")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeFor("x.hwpx")).toBe("application/octet-stream");
  });
});
