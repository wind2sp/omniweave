// Web app as an installable app (PWA), build side: the web app manifest, home-screen icons, iPhone start-up images,
// the head tags for them, and the offline service worker sw.js (src/web/sw.js filled with this build's file list).
// Web build only — OMW_WEB=1 (the Pages workflow, the local web preview). The desktop build (npm run build / tauri)
// gets none of it, so the installer carries no web-only files. The browser side: src/web/pwa.ts.
// Policy: src/web/sw.js, docs/RELEASING.md §웹판 업데이트. Plain JS (vite.config.ts imports it; no Node types in tsc).
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Web app files (src/web): manifest, icons, start-up images, the service worker template. */
export const WEB_DIR = fileURLToPath(new URL("../src/web/", import.meta.url));

/** Files the service worker installs with each build: the app shell (scripts, styles, UI fonts, pdf.js data, icons).
 *  Not the AI models (models/**, *.lwt — cached on first use), start-up images (read once by iOS), licences, maps. */
export function precacheList(files) {
  return [...new Set(files.map((f) => f.replace(/\\/g, "/")))]
    .filter((f) => f !== "index.html" && f !== "sw.js" && f !== "version.json" && f !== "demo.omw")
    .filter((f) => !/^models\//.test(f) && !/\.(lwt|map)$/.test(f) && !/^icons\/splash-/.test(f) && !/(^|\/)(OFL|LICENSE)[^/]*$/.test(f))
    .sort();
}

/** The service worker for one build (src/web/sw.js with its constants filled in). */
export function swSource(template, build, precache, models) {
  const out = template
    .replace('"__OMW_BUILD__"', () => JSON.stringify(build))
    .replace("/* __OMW_PRECACHE__ */ []", () => JSON.stringify(precache))
    .replace('"__OMW_MODELS__"', () => JSON.stringify(models));
  if (/"__OMW_|__OMW_PRECACHE__/.test(out)) throw new Error("omw-web-pwa: sw.js template placeholders changed");
  return out;
}

/** iPhone start-up image link for `splash-<w>x<h>-<dpr>x.png` (assets/make_icon.py IPHONE_SPLASH), or null. */
export function splashLink(file) {
  const m = /^splash-(\d+)x(\d+)-(\d)x\.png$/.exec(file);
  if (!m) return null;
  const [w, h, dpr] = [+m[1], +m[2], +m[3]];
  return {
    href: `icons/${file}`,
    media: `(device-width: ${w / dpr}px) and (device-height: ${h / dpr}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)`,
  };
}

function walkFiles(dir, base = dir, out = []) {
  if (!dir || !existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, "/"));
  }
  return out;
}

/** @param {boolean} [enabled] default: OMW_WEB=1 */
export function webPwa(enabled = process.env.OMW_WEB === "1") {
  let publicDir = "";
  const icons = () => (existsSync(join(WEB_DIR, "icons")) ? readdirSync(join(WEB_DIR, "icons")).filter((f) => f.endsWith(".png")).sort() : []);
  return {
    name: "omw-web-pwa",
    apply: () => enabled,
    configResolved(c) {
      publicDir = c.publicDir;
    },
    transformIndexHtml() {
      const tag = (tag, attrs) => ({ tag, attrs, injectTo: "head" });
      return [
        tag("link", { rel: "manifest", href: "manifest.webmanifest" }),
        tag("meta", { name: "mobile-web-app-capable", content: "yes" }),
        tag("meta", { name: "apple-mobile-web-app-capable", content: "yes" }),
        tag("meta", { name: "apple-mobile-web-app-title", content: "Omniweave" }),
        // opaque black bar above the page (the page starts below it), close to the dark window colour
        tag("meta", { name: "apple-mobile-web-app-status-bar-style", content: "black" }),
        tag("link", { rel: "apple-touch-icon", href: "icons/apple-touch-icon.png" }),
        ...icons()
          .map(splashLink)
          .filter(Boolean)
          .map((l) => tag("link", { rel: "apple-touch-startup-image", href: l.href, media: l.media })),
      ];
    },
    generateBundle(_opts, bundle) {
      const entry = Object.values(bundle).find((o) => o.type === "chunk" && o.isEntry && o.name === "index");
      if (!entry) return;
      const build = entry.fileName.split("/").pop();
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: readFileSync(join(WEB_DIR, "manifest.webmanifest")) });
      for (const f of icons()) this.emitFile({ type: "asset", fileName: `icons/${f}`, source: readFileSync(join(WEB_DIR, "icons", f)) });
      const pub = walkFiles(publicDir);
      const files = [...Object.keys(bundle), ...pub, "manifest.webmanifest", ...icons().map((f) => `icons/${f}`)];
      // the model cache outlives app updates while the model files (names, sizes) stay the same
      const h = createHash("sha256");
      for (const f of pub.filter((f) => f.startsWith("models/")).sort()) h.update(`${f}:${statSync(join(publicDir, f)).size}\n`);
      for (const f of Object.keys(bundle).filter((f) => f.endsWith(".lwt")).sort()) h.update(`${f}\n`);
      const template = readFileSync(join(WEB_DIR, "sw.js"), "utf8");
      this.emitFile({ type: "asset", fileName: "sw.js", source: swSource(template, build, precacheList(files), h.digest("hex").slice(0, 12)) });
    },
  };
}
