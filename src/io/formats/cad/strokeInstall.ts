// Registers Omni Stroke (cad/strokeFont.ts) as a FontFace when a drawing's text needs it: on opening a DXF / DWG with
// SHX text, and when a document set in it is opened (core/text.ts asks once). The font is built in memory — Latin,
// symbols, Hangul jamo, the 2,350 common syllables (KS X 1001) and any other syllable the open document uses — and
// rebuilt only when a document brings syllables it lacks. Nothing is stored in documents or shipped as a file.
// Text in an SHX style whose files were found on this computer (cad/shxLoad.ts) gets a face of its own per style
// ("Omni Stroke SHX romans"), built from the user's SHX shapes the same way.

import { shxPairOf, strokeFamilyOf, strokeFontTtf, strokeVariantOf, type ShxPairRef, type StrokeVariant } from "./strokeFont";

let have = new Set<string>();
let faces: FontFace[] = [];
let busy: Promise<void> | null = null;
/** SHX variants installed → the text they were built for */
const shxFaces = new Map<string, { text: Set<string>; faces: FontFace[]; pair: ShxPairRef }>();

/** The 2,350 Hangul syllables of KS X 1001 (EUC-KR rows B0–C8). */
function commonSyllables(): string {
  try {
    const bytes: number[] = [];
    for (let r = 0xb0; r <= 0xc8; r++) for (let c = 0xa1; c <= 0xfe; c++) bytes.push(r, c);
    return new TextDecoder("euc-kr").decode(new Uint8Array(bytes));
  } catch {
    return "";
  }
}

/** Hangul syllables of a text */
const syllables = (s: string) => [...s].filter((ch) => ch >= "가" && ch <= "힣"); // i18n: keep — glyph data

const canInstall = () => typeof document !== "undefined" && typeof FontFace !== "undefined" && "fonts" in document;

/** Make sure the font is installed and covers the syllables in `text`. Resolves once the faces are loaded. */
export async function installStrokeFont(text = "", variants: Iterable<StrokeVariant> = []): Promise<void> {
  if (!canInstall()) return;
  while (busy) await busy;
  busy = (async () => {
    const want = syllables(text);
    if (!faces.length || !want.every((ch) => have.has(ch))) {
      const all = new Set([...(have.size ? have : syllables(commonSyllables())), ...want]);
      const next = (["prop", "mono"] as const).flatMap((v) => [false, true].map((italic) => new FontFace(strokeFamilyOf(v), strokeFontTtf(all, italic, v) as BufferSource, { style: italic ? "italic" : "normal", weight: "100 900" })));
      await Promise.all(next.map((f) => f.load()));
      for (const f of faces) document.fonts.delete(f);
      for (const f of next) document.fonts.add(f);
      faces = next;
      have = all;
    }
    // SHX styles: ASCII always, other characters as the text uses them (a big font has thousands)
    const chars = new Set([...text].filter((ch) => ch > "~"));
    for (const v of new Set(variants)) {
      if (!v.startsWith("shx:")) continue;
      const old = shxFaces.get(v);
      // (rebuilt as well when the style's files changed: another drawing's folder had its own romans.shx)
      const pair = shxPairOf(v);
      if (old && old.pair === pair && [...chars].every((ch) => old.text.has(ch))) continue;
      // (not Omni Stroke's 2,350 common syllables: built per SHX style they cost seconds and megabytes on opening a
      // drawing with many styles — a big font has the text's syllables, a style without one draws "?" for them)
      const set = new Set([...(old?.text ?? []), ...chars]);
      const next = [false, true].map((italic) => new FontFace(strokeFamilyOf(v), strokeFontTtf(set, italic, v) as BufferSource, { style: italic ? "italic" : "normal", weight: "100 900" }));
      await Promise.all(next.map((f) => f.load()));
      for (const f of old?.faces ?? []) document.fonts.delete(f);
      for (const f of next) document.fonts.add(f);
      shxFaces.set(v, { text: set, faces: next, pair });
    }
  })();
  try {
    await busy;
  } finally {
    busy = null;
  }
}

/** Install for the text of the open document (runs set in Omni Stroke), e.g. after an .omw with drawing text opens. */
export async function installStrokeFontForDocument(): Promise<void> {
  const { useStore } = await import("../../../core/store");
  const doc = useStore.getState().doc;
  let text = "";
  const variants = new Set<StrokeVariant>();
  const families = new Set<string>();
  for (const p of doc.pages)
    for (const n of p.nodes)
      if (n.type === "TEXT")
        for (const para of n.paragraphs)
          for (const r of para.runs) {
            const v = strokeVariantOf(r.fontFamily);
            if (!v) continue;
            text += r.text;
            variants.add(v);
            if (v.startsWith("shx:")) families.add(r.fontFamily);
          }
  // SHX styles: the user's AutoCAD fonts again when they are installed here; Omni Stroke's shapes otherwise
  if (families.size) {
    const [{ loadShxFamilies }, { cadFileReader }] = await Promise.all([import("./shxLoad"), import("./external")]);
    await loadShxFamilies(families, cadFileReader()).catch(() => {});
  }
  await installStrokeFont(text, variants);
}
