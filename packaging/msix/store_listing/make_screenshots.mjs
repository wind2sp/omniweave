#!/usr/bin/env node
// Store screenshots: the real app (the web build in dist/) in each UI language, 1920×1080, captured by headless
// Microsoft Edge over the DevTools protocol (no new dependencies: Node's own WebSocket and http).
//
//   npm run build            (or vite build) → dist/
//   node packaging/msix/store_listing/make_screenshots.mjs [--langs ko,en] [--only 1-document] [--out <dir>]
//   → packaging/msix/store_listing/screenshots/<lang>/<n>-<scene>.png
//
// Documents shown: only the repository's own test files (omni-/omw- names, made for testing) and the demo workspace —
// no user documents, real names, internal code names or other companies' logos (the document sample is the Store variant:
// node scripts/make-doc-sample.mjs --store → qa/samples/store-sample/). Files are dropped onto the tab strip the way a user drags
// them in. Edge runs headless (no window) with a throwaway profile.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const LANGS = (opt("--langs") ?? "ko,en,ja,zh").split(",");
const OUT = resolve(opt("--out") ?? join(HERE, "screenshots"));
const W = Number(opt("--width") ?? 1920), H = Number(opt("--height") ?? 1080);

/** scene → files dropped in (served under /samples/), then a few UI steps */
export const SCENES = [
  { id: "1-document", files: ["qa/samples/store-sample/omni-store-sample.docx"] },
  { id: "2-slides", files: ["qa/interop/omniweave-made/ppt-01-slides.pptx"] },
  { id: "3-image", files: ["qa/interop/omniweave-made/psd-01-new-rgb8-layers.psd"] },
  { id: "4-design", files: ["qa/interop/adobe-made/ai-fidelity/omni-ai-gradients.ai"] },
  { id: "5-pdf", files: ["qa/samples/store-sample/omni-store-sample.pdf"] },
  { id: "6-drawing", files: ["qa/interop/autocad-made/omni-cad-02-layers-2018.dxf"] },
];

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };

function serve() {
  const dist = join(ROOT, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("dist/index.html missing — build the web app first (npx vite build)");
  const allowed = new Set(SCENES.flatMap((s) => s.files));
  const srv = createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file;
    if (url.startsWith("/samples/")) {
      const rel = url.slice("/samples/".length);
      file = allowed.has(rel) ? join(ROOT, rel) : null;
    } else file = join(dist, url === "/" ? "index.html" : url);
    if (!file || !file.startsWith(url.startsWith("/samples/") ? ROOT : dist) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(file));
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok(srv)));
}

function edgePath() {
  const c = [process.env.OMW_EDGE, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].filter(Boolean);
  const p = c.find((x) => existsSync(x));
  if (!p) throw new Error("Microsoft Edge not found (set OMW_EDGE)");
  return p;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const profile = mkdtempSync(join(tmpdir(), "omw-shot-"));
  const port = 9300 + Math.floor(Math.random() * 500);
  const proc = spawn(edgePath(), ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, "--force-device-scale-factor=1", "--hide-scrollbars", "--no-first-run", "--disable-extensions", "--enable-unsafe-webgpu", "about:blank"], { windowsHide: true, stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return { proc, profile, ws: page.webSocketDebuggerUrl };
    } catch {}
    await sleep(200);
  }
  throw new Error("Edge did not start");
}

class Cdp {
  constructor(url) {
    this.id = 0;
    this.wait = new Map();
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id && this.wait.has(d.id)) {
        const [ok, ko] = this.wait.get(d.id);
        this.wait.delete(d.id);
        d.error ? ko(new Error(d.error.message)) : ok(d.result);
      }
    };
    this.open = new Promise((r) => (this.ws.onopen = r));
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((ok, ko) => {
      this.wait.set(id, [ok, ko]);
      setTimeout(() => this.wait.has(id) && (this.wait.delete(id), ko(new Error(`${method}: no answer`))), 60000);
    });
  }
  async eval(expr) {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
}

/** drop files on the tab strip as a user drag would */
const dropJs = (urls) => `(async () => {
  const strip = await (async () => { for (let i = 0; i < 100; i++) { const s = document.querySelector(".doc-tabs-strip"); if (s) return s; await new Promise(r => setTimeout(r, 100)); } throw new Error("no tab strip"); })();
  const dt = new DataTransfer();
  for (const u of ${JSON.stringify(urls)}) { const b = await (await fetch(u)).blob(); dt.items.add(new File([b], u.split("/").pop())); }
  strip.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  strip.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  return true;
})()`;

async function main() {
  const srv = await serve();
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const edge = await launch();
  const cdp = new Cdp(edge.ws);
  await cdp.open;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  try {
    for (const lang of LANGS) {
      mkdirSync(join(OUT, lang), { recursive: true });
      for (const sc of SCENES) {
        if (opt("--only") && !sc.id.includes(opt("--only"))) continue;
        await cdp.send("Page.navigate", { url: `${origin}/index.html` });
        await sleep(1500);
        await cdp.eval(`localStorage.clear(); localStorage.setItem("omniweave.lang", ${JSON.stringify(lang)}); true`);
        await cdp.send("Page.reload", { ignoreCache: true });
        await sleep(3000);
        await cdp.eval(dropJs(sc.files.map((f) => `${origin}/samples/${f}`)));
        await sleep(Number(opt("--settle") ?? 6000));
        // close a start screen or notice left over the document
        await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
        // a page of a multi-page file: click its thumbnail label ("<name> · n")
        if (sc.page)
          await cdp.eval(`(async () => {
            const end = "· " + ${sc.page};
            const el = [...document.querySelectorAll("div,span")].find((e) => e.children.length === 0 && e.textContent.trim().endsWith(end));
            if (!el) return false;
            el.scrollIntoView({ block: "center" });
            await new Promise((r) => setTimeout(r, 300));
            const r = (el.previousElementSibling ?? el).getBoundingClientRect();
            return [r.x + r.width / 2, r.y + r.height / 2];
          })()`).catch(() => null).then(async (at) => {
            if (!at) return;
            for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", { type, x: at[0], y: at[1], button: "left", clickCount: 1 });
            await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: W / 2, y: H - 40 }); // no hover toolbar in the picture
          });
        await sleep(1200);
        for (const key of sc.keys ?? []) {
          const vk = { PageDown: 34, PageUp: 33, End: 35, Home: 36 }[key] ?? 0;
          await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: key, windowsVirtualKeyCode: vk });
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: vk });
          await sleep(400);
        }
        await sleep(800);
        const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const file = join(OUT, lang, `${sc.id}.png`);
        writeFileSync(file, Buffer.from(shot.data, "base64"));
        console.log(file);
      }
    }
  } finally {
    try {
      await Promise.race([cdp.send("Browser.close"), sleep(3000)]);
    } catch {}
    srv.close();
    await sleep(500);
    try {
      edge.proc.kill();
    } catch {}
    try {
      rmSync(edge.profile, { recursive: true, force: true });
    } catch {}
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => (console.error(e), process.exit(1)));
