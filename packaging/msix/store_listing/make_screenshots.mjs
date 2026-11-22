#!/usr/bin/env node
// Store screenshots: the real app (the web build in dist/) in each UI language, 1920×1080, captured by headless
// Microsoft Edge over the DevTools protocol (no new dependencies: Node's own WebSocket and http).
//
//   npm run build            (or vite build) → dist/
//   node packaging/msix/store_listing/make_screenshots.mjs [--langs ko,en] [--only 1-document] [--out <dir>]
//   → packaging/msix/store_listing/screenshots/<lang>/<n>-<scene>.png + highlights.json
//
// highlights.json: for each scene, the rectangles (percent of the picture) of the UI parts the homepage points at
// (website "화면 둘러보기": numbered boxes over the picture), read from the app's DOM right after the capture, so the
// boxes match every language's layout. python website/make-shots.py turns the PNGs + highlights.json into the site's WebP.
//
// Documents shown: only the repository's own test files (omni- names, made for testing) in each UI language — no user
// documents, real names, internal code names or other companies' logos. They are made by
//   node scripts/make-doc-sample.mjs --store --lang <lang>                         (document DOCX, PDF)
//   OMW_STORE_SAMPLES=1 npx vitest run scripts/make-store-samples.test.ts --dir scripts   (slides PPTX, image PSD)
//   python packaging/msix/store_listing/make_store_samples.py                    (design AI, drawing DXF)
// → qa/samples/store-sample/<lang>/. Files are dropped onto the tab strip the way a user drags them in.
// Edge runs headless (no window) with a throwaway profile.
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
const S = (lang, name) => `qa/samples/store-sample/${lang}/${name}`;
/**
 * scene → files dropped in (served under /samples/), then a few UI steps. `marks`: an expression run in the page that
 * returns, for each numbered box on the homepage, the elements it surrounds (their union, clipped to the window).
 */
export const SCENES = [
  { id: "1-document", files: (l) => [S(l, "omni-store-sample.docx")], marks: `[[q(".mode-switch")], qa(".dock-nav .nav-row"), [qa(".dock-right section.section")[0]]]` },
  { id: "2-slides", files: (l) => [S(l, "omni-store-slides.pptx")], marks: `[qa(".dock-left .page-row"), [qa(".dock-right section.section")[1]], [q(".tabrow .btn-primary")]]` },
  { id: "3-image", files: (l) => [S(l, "omni-store-layers.psd")], marks: `[qa(".dock-left .layer-row"), [q(".dock-left .layer-bar .select")], [q(".toolbox .tool-strip")]]` },
  { id: "4-design", files: (l) => [S(l, "omni-store-design.ai")], marks: `[[q(".dock-left .page-row, .dock-left .layer-row")], [q(".toolbox .tool-strip")], [q(".dock-right section.section .grid2"), q(".dock-right section.section .preset-row")]]` },
  { id: "5-pdf", files: (l) => [S(l, "omni-store-sample.pdf")], marks: `[[qa(".ribbon .rg")[0]], [qa(".ribbon .rg")[1]], qa(".ribbon .rg").slice(2, 5)]` },
  { id: "6-drawing", files: (l) => [S(l, "omni-store-drawing.dxf")], marks: `[[q(".cad-lm-table")], [qa(".ribbon .rg")[1]], [q(".cad-cmd-row")]]` },
];

/** the boxes of a scene as percent of the window (x, y, w, h; one decimal) */
const marksJs = (expr) => `(() => {
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const W = innerWidth, H = innerHeight;
  const pct = (v, of) => Math.round((v / of) * 1000) / 10;
  return ${expr}.map((els) => {
    // a part inside a side panel is clipped to the panel (a wide table scrolls inside its dock)
    const box = (e) => {
      const r = e.getBoundingClientRect(), d = e.closest(".dock")?.getBoundingClientRect();
      const b = d ? { left: Math.max(r.left, d.left), top: Math.max(r.top, d.top), right: Math.min(r.right, d.right), bottom: Math.min(r.bottom, d.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      return { ...b, width: b.right - b.left, height: b.bottom - b.top };
    };
    const rs = els.filter(Boolean).map(box).filter((r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H);
    if (!rs.length) return null;
    const x0 = Math.max(0, Math.min(...rs.map((r) => r.left))), y0 = Math.max(0, Math.min(...rs.map((r) => r.top)));
    const x1 = Math.min(W, Math.max(...rs.map((r) => r.right))), y1 = Math.min(H, Math.max(...rs.map((r) => r.bottom)));
    return { x: pct(x0, W), y: pct(y0, H), w: pct(x1 - x0, W), h: pct(y1 - y0, H) };
  });
})()`;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".ttf": "font/ttf" };

function serve() {
  const dist = join(ROOT, "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("dist/index.html missing — build the web app first (npx vite build)");
  const allowed = new Set(SCENES.flatMap((s) => LANGS.flatMap((l) => s.files(l))));
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
      const hlFile = join(OUT, lang, "highlights.json");
      const highlights = existsSync(hlFile) ? JSON.parse(readFileSync(hlFile, "utf8")) : {};
      for (const sc of SCENES) {
        if (opt("--only") && !sc.id.includes(opt("--only"))) continue;
        await cdp.send("Page.navigate", { url: `${origin}/index.html` });
        await sleep(1500);
        await cdp.eval(`localStorage.clear(); localStorage.setItem("omniweave.lang", ${JSON.stringify(lang)}); true`);
        await cdp.send("Page.reload", { ignoreCache: true });
        await sleep(3000);
        await cdp.eval(dropJs(sc.files(lang).map((f) => `${origin}/samples/${f}`)));
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
        highlights[sc.id] = await cdp.eval(marksJs(sc.marks));
        console.log(file, JSON.stringify(highlights[sc.id]));
      }
      writeFileSync(hlFile, JSON.stringify(highlights, null, 2) + "\n");
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
