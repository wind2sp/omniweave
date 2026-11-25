// Open a link (TextRun.link): a web / mail address in the browser (the desktop app: the system's); a bookmark ("#name")
// is said not to be followed here. Kept apart from ui/linkActions.ts so the body editor can use it without the ribbon.

import { useStore } from "../core/store";
import { t } from "../i18n";
import { isTauri } from "../io/platform";

export function openLink(url: string): void {
  if (url.startsWith("#")) return useStore.getState().notify(t("docux.link.bookmark", { name: url.slice(1) }));
  if (isTauri) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => window.open(url, "_blank", "noopener"));
  else window.open(url, "_blank", "noopener");
}