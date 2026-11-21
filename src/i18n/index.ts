// UI language (한국어 · English · 中文(简体) · 日本語). Strings live in {ko,en,zh,ja}.json (shell, menus, commands)
// and parts/<area>/{ko,en,zh,ja}.json (one per screen group), keyed by dotted ids;
// a missing key falls back to Korean, then to the key itself. The choice is per viewer (localStorage); the first
// run of an installed copy uses the language picked in the installer, otherwise the OS / browser language.

// No imports from core / io: the engine itself uses t() for its messages, so this module must not depend on it.
import { create } from "zustand";
import en from "./en.json";
import ja from "./ja.json";
import ko from "./ko.json";
import zh from "./zh.json";

export type Lang = "ko" | "en" | "zh" | "ja";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Title a new document starts with (stored as is); docTitle() shows it in the viewer's language. */
export const DEFAULT_TITLE = "제목 없음";
type Dict = Record<string, string>;

/** Languages in menu order, each named in its own language. */
export const LANGS: { id: Lang; name: string }[] = [
  { id: "ko", name: "한국어" },
  { id: "en", name: "English" },
  { id: "zh", name: "中文(简体)" },
  { id: "ja", name: "日本語" },
];

/** Per-area files `parts/<area>/<lang>.json` (one area per screen group, so they can be edited apart). */
const PARTS = import.meta.glob<Dict>("./parts/*/*.json", { eager: true, import: "default" });

/** Keys defined in more than one Korean file (each key belongs to exactly one file). */
export const DUPLICATE_KEYS: string[] = [];

function merged(lang: Lang, base: Dict): Dict {
  const out: Dict = { ...base };
  for (const [path, d] of Object.entries(PARTS)) {
    if (!path.endsWith(`/${lang}.json`)) continue;
    for (const [k, v] of Object.entries(d)) {
      if (k in out && lang === "ko") DUPLICATE_KEYS.push(`${path}: ${k}`);
      out[k] = v;
    }
  }
  return out;
}

export const DICTS: Record<Lang, Dict> = { ko: merged("ko", ko), en: merged("en", en), zh: merged("zh", zh), ja: merged("ja", ja) };

const KEY = "omniweave.lang";

export const useLang = create<{ lang: Lang; set: (l: Lang, remember?: boolean) => void }>((set) => ({
  lang: "ko",
  /** `remember` = the viewer chose it (Preferences); a detected language is not saved, so it follows later changes */
  set: (lang, remember = true) => {
    set({ lang });
    if (remember)
      try {
        localStorage.setItem(KEY, lang);
      } catch {}
    if (typeof document !== "undefined") document.documentElement.lang = lang === "zh" ? "zh-Hans" : lang;
  },
}));

const isLang = (v: unknown): v is Lang => v === "ko" || v === "en" || v === "zh" || v === "ja";

/** BCP-47 tag ("en-US", "zh-CN", "ja") → a supported language; Korean otherwise. */
export function langFromTag(tag: string | null | undefined): Lang {
  const p = (tag ?? "").toLowerCase();
  if (p.startsWith("en")) return "en";
  if (p.startsWith("zh")) return "zh";
  if (p.startsWith("ja")) return "ja";
  return "ko";
}

/**
 * Text for `key` in the current language; `{name}` placeholders are filled from `vars`. `fallback` (for labels
 * that come from a registry, not yet in the language files) is used when no file has the key.
 */
export function t(key: string, vars?: Record<string, string | number>, fallback?: string): string {
  const s = DICTS[useLang.getState().lang][key] ?? DICTS.ko[key] ?? fallback ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** `t`, re-rendering the component when the language changes. */
export function useT(): typeof t {
  useLang((s) => s.lang);
  return t;
}

/** Pick the starting language: saved choice → installer choice (desktop) → OS / browser language. */
export async function initLang(): Promise<void> {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {}
  if (isLang(saved)) return useLang.getState().set(saved);
  if (isTauri) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const picked = await invoke<string | null>("installer_language");
      if (isLang(picked)) return useLang.getState().set(picked, false);
    } catch {}
  }
  useLang.getState().set(langFromTag(typeof navigator !== "undefined" ? navigator.language : null), false);
}

/** A document's title as shown and used for file names: the default title of a new document in the viewer's language. */
export function docTitle(title: string | null | undefined): string {
  return !title || title === DEFAULT_TITLE ? t("shell.untitled") : title;
}
