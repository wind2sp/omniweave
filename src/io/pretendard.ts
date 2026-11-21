// Pretendard Regular/Bold — shipped packed (public/fonts/*.ttpack, src/io/fontPack.ts) instead of as TTF + woff2:
// one file per weight serves both the UI (FontFace) and PDF export (fontkit subsets of the exact original TTF).
// docs/design/INSTALLER_SIZE.md §7. Medium/SemiBold stay woff2 in styles.css (UI only).

import { unpackTtf } from "./fontPack";

export type PretendardWeight = "regular" | "bold";
export const PRETENDARD_FILES = { regular: "Pretendard-Regular.ttpack", bold: "Pretendard-Bold.ttpack" } as const;

/**
 * Font URL next to the app: resolved against the page, not the site root, so the build also works
 * under a sub-path (vite base "./", e.g. the hosted /app/ demo) and in Tauri.
 */
export function fontUrl(file: string): string {
  const g = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };
  const base = g.document?.baseURI ?? g.location?.href;
  return base ? new URL(`fonts/${file}`, base).href : `fonts/${file}`;
}

const cache = new Map<PretendardWeight, Promise<Uint8Array>>();

/** The original Pretendard TTF bytes (fetched and unpacked once per weight). */
export function pretendardTtf(weight: PretendardWeight): Promise<Uint8Array> {
  let p = cache.get(weight);
  if (!p) {
    p = (async () => {
      const file = PRETENDARD_FILES[weight];
      const res = await fetch(fontUrl(file));
      if (!res.ok) throw new Error(`font ${file}: ${res.status}`);
      return unpackTtf(new Uint8Array(await res.arrayBuffer()));
    })();
    p.catch(() => cache.delete(weight));
    cache.set(weight, p);
  }
  return p;
}

/** UI faces "Pretendard" 400 and 700 (the CSS declares 500 and 600). */
export async function installUiFonts(): Promise<void> {
  const [regular, bold] = await Promise.all([pretendardTtf("regular"), pretendardTtf("bold")]);
  const faces = [
    new FontFace("Pretendard", regular, { weight: "400", style: "normal", display: "swap" }),
    new FontFace("Pretendard", bold, { weight: "700", style: "normal", display: "swap" }),
  ];
  for (const f of faces) document.fonts.add(f);
  await Promise.all(faces.map((f) => f.load()));
}
