// Omniweave web app service worker (template: vite.config.ts webPwa fills the three constants below and emits
// sw.js next to index.html in the web build only; the desktop app never registers it — src/web/pwa.ts).
//
// Policy (docs/RELEASING.md §웹판 업데이트):
// - Every build has its own shell cache "omw-shell-<build>": index.html, all scripts/styles, UI fonts, icons,
//   pdf.js data. Installed in full before the worker can take over, so an offline start always has a matching set.
// - Pages are answered from that cache (the app opens offline and instantly). A new build is found by the browser's
//   own sw.js check (each start, and reg.update() when version.json names another build); it installs in the
//   background and WAITS. The page shows "새로 고쳐서 업데이트"; clicking it posts SKIP_WAITING, the new worker
//   takes over and the page reloads. Closing every window of the app (or the iOS home-screen app being ended) also
//   lets it take over on the next start. No automatic skipWaiting: an open tab keeps its own build's lazy chunks.
// - Never stuck on an old build: sw.js itself is fetched past the HTTP cache (updateViaCache "none"), version.json is
//   never cached, a shell install that gets a stale index.html (Pages max-age=600) fails and is retried later, and
//   `?sw=off` on the page URL unregisters the worker and drops every cache (support escape hatch).
// - AI models (models/**, *.lwt) are cached the first time they are used, in "omw-models-<hash of the model files>",
//   which survives app updates while the models stay the same. Other same-origin files (demo.omw, ...) are cached
//   on use per build. Old caches are deleted when a new worker activates.

const BUILD = "__OMW_BUILD__";
const PRECACHE = /* __OMW_PRECACHE__ */ [];
const MODELS = "__OMW_MODELS__";

// Cache names are per origin, not per scope: the test channel (/app-beta/, docs/RELEASING.md §웹판 업데이트) uses
// its own prefix so its worker and the release one (/app/, which deletes every other "omw-" cache) never drop each
// other's caches.
const PREFIX = cachePrefix(self.registration.scope);
const SHELL = PREFIX + "shell-" + BUILD;
const RUNTIME = PREFIX + "run-" + BUILD;
const MODEL_CACHE = PREFIX + "models-" + MODELS;
const OURS = [SHELL, RUNTIME, MODEL_CACHE];

/** "omwbeta-" under …/app-beta/, else "omw-" (the same rule as src/web/pwa.ts cachePrefix) */
function cachePrefix(scope) {
  return /\/app-beta\/$/.test(new URL(scope).pathname) ? "omwbeta-" : "omw-";
}

const scopeUrl = (p) => new URL(p, self.registration.scope).href;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // past the HTTP cache: GitHub Pages serves every file with max-age=600, an older index.html could be there
      const urls = ["./", ...PRECACHE];
      await Promise.all(
        urls.map(async (p) => {
          const res = await fetch(new Request(scopeUrl(p), { cache: "reload" }));
          if (!res.ok) throw new Error(`omw-sw: ${p} ${res.status}`);
          if (p === "./") {
            const html = await res.clone().text();
            // the page must be the one this worker belongs to, or the next try (browser's update check) does it again
            if (!html.includes(BUILD)) throw new Error("omw-sw: index.html is from another build");
          }
          await cache.put(scopeUrl(p), res);
        }),
      );
    })().catch(async (e) => {
      await caches.delete(SHELL);
      throw e;
    }),
  );
  // first install (no page controlled yet): take over at once; an update waits for the page (see the policy above)
  if (!self.registration.active) self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith(PREFIX) && !OURS.includes(name)) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

const isModel = (path) => /(^|\/)models\//.test(path) || /\.lwt$/.test(path);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const path = url.pathname.slice(scope.pathname.length);
  if (path === "version.json" || path === "sw.js") return; // always the network (update checks)
  // the high-quality background removal model (46 MB): the app checks and keeps it itself (birefnetModel.ts, cache
  // "hq-models") — not a second copy here
  if (/(^|\/)models\/birefnet\//.test(path)) return;

  if (req.mode === "navigate") {
    if (url.searchParams.has("sw")) return; // ?sw=off: let the page reach the network and unregister
    event.respondWith(
      (async () => {
        const hit = await caches.match(scopeUrl("./"), { cacheName: SHELL });
        if (hit) return hit;
        return fetch(req);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const shell = await caches.match(url.href, { cacheName: SHELL, ignoreSearch: true });
      if (shell) return shell;
      const name = isModel(path) ? MODEL_CACHE : RUNTIME;
      const cache = await caches.open(name);
      const hit = await cache.match(req, { ignoreSearch: false });
      if (hit) return hit;
      const res = await fetch(req);
      // whole files only (no Range answers), from this site
      if (res.ok && res.status === 200 && res.type === "basic") await cache.put(req, res.clone()).catch(() => {});
      return res;
    })(),
  );
});
