// Web app update (docs/RELEASING.md §웹판 업데이트): the browser build has no installer — an "update" is a new build on
// the server. Each build publishes version.json next to index.html (vite.config.ts webVersion) naming its entry
// script; this tab compares it with the entry script it is running. When they differ, a pill offers
// "Reload to update" (unsaved edits stay in the autosave journal and come back after the reload). A lazy chunk that
// is gone after a new deployment (hashed names, the old build replaced) shows the same pill instead of a dead feature.
// GitHub Pages caches every file for 10 minutes (max-age=600), so version.json is read with cache: "no-store".

import { useEffect, useState } from "react";
import { useStore } from "../../core/store";
import { t as tr, useT } from "../../i18n";
import { isTauri } from "../../io/platform";
import { Icon } from "./Icons";

const PERIOD_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 10_000;
/** checks on returning to the tab are at most this often */
const MIN_GAP_MS = 30 * 60 * 1000;

export interface WebVersion {
  version?: string;
  build?: string;
}

/** The entry script this page runs (`assets/index-<hash>.js`), or null in the dev server. */
export function currentBuild(doc: Pick<Document, "querySelector"> = document): string | null {
  const src = doc.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.getAttribute("src");
  const m = src && /assets\/(index-[\w-]+\.js)/.exec(src);
  return m ? m[1] : null;
}

/** A newer build is on the server: its version.json names another entry script than the running one. */
export function isNewBuild(remote: WebVersion | null, current: string | null): boolean {
  return !!(remote && current && typeof remote.build === "string" && remote.build && remote.build !== current);
}

async function fetchVersion(): Promise<WebVersion | null> {
  try {
    const r = await fetch(new URL("version.json", location.href).href, { cache: "no-store" });
    return r.ok ? ((await r.json()) as WebVersion) : null;
  } catch {
    return null; // offline: try again later
  }
}

type St = null | { kind: "new"; version?: string } | { kind: "stale" };

/** The pill in the title bar (browser only; renders nothing until a new build is found). */
export function WebUpdatePill() {
  const t = useT();
  const [st, setSt] = useState<St>(null);

  useEffect(() => {
    if (isTauri) return;
    const cur = currentBuild();
    let last = 0;
    const check = async () => {
      if (!cur || Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      const remote = await fetchVersion();
      if (isNewBuild(remote, cur)) setSt((s) => s ?? { kind: "new", version: remote?.version });
    };
    // a lazy chunk of this build is gone (a new build replaced it): the feature cannot load until a reload
    const onPreloadError = () => {
      setSt((s) => {
        if (!s) useStore.getState().notify(tr("web.update.stale"));
        return s ?? { kind: "stale" };
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    const first = setTimeout(() => void check(), FIRST_CHECK_MS);
    const periodic = setInterval(() => {
      last = 0;
      void check();
    }, PERIOD_MS);
    window.addEventListener("vite:preloadError", onPreloadError);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(first);
      clearInterval(periodic);
      window.removeEventListener("vite:preloadError", onPreloadError);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!st) return null;
  const tip = st.kind === "new" && st.version ? `${t("web.update.tip", { version: st.version })} — ${t("web.update.keep")}` : t("web.update.keep");
  return (
    <button type="button" className="update-pill is-ready" data-tip={tip} aria-live="polite" onClick={() => location.reload()}>
      <Icon name="rotate" size={14} />
      <span className="update-pill-label">{t("web.update.reload")}</span>
    </button>
  );
}
