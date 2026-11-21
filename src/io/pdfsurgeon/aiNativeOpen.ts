// PDF Surgeon — open an .ai saved without PDF content from Illustrator's native data (aiNative.ts → aiNativePdf.ts).
// Loaded on demand (formats/index.ts) the first time such a file is opened.

import { t } from "../../i18n";
import { interpretNative, readNativeDocument } from "./aiNative";
import { nativeToPdf } from "./aiNativePdf";

/** note key (aiNative.ts) → message key; {n} is the count */
const NOTE_KEYS: Record<string, string> = {
  "placed-preview": "engine.ai.native.placedPreview",
  "placed-missing": "engine.ai.native.placedMissing",
  foreign: "engine.ai.native.foreign",
  "foreign-missing": "engine.ai.native.foreignMissing",
  "raster-unknown": "engine.ai.native.rasterUnknown",
  "raster-1bit": "engine.ai.native.rasterUnknown",
  "raster-truncated": "engine.ai.native.rasterTruncated",
  "text-path": "engine.ai.native.textPath",
  "text-vertical": "engine.ai.native.textVertical",
  "text-unread": "engine.ai.native.textUnread",
  "gradient-missing": "engine.ai.native.gradientMissing",
  "symbol-missing": "engine.ai.native.symbolMissing",
  "symbol-damaged": "engine.ai.native.symbolMissing",
  "pattern-missing": "engine.ai.native.patternMissing",
  damaged: "engine.ai.native.damaged",
  "too-large": "engine.ai.native.tooLarge",
};

export interface NativeOpen {
  pdf: Uint8Array;
  /** what is drawn differently or not at all (current UI language) */
  notes: string[];
  fonts: string[];
}

/** The art of an .ai without PDF content as a PDF (one page per artboard), or null when its native data is unreadable. */
export async function openAiNative(bytes: Uint8Array): Promise<NativeOpen | null> {
  const native = await readNativeDocument(bytes);
  if (!native) return null;
  const doc = interpretNative(native);
  if (!doc || !doc.artboards.length) return null;
  const { pdf, fonts } = await nativeToPdf(doc);
  const notes: string[] = [];
  const merged = new Map<string, number>();
  for (const [k, n] of doc.notes) {
    const key = NOTE_KEYS[k] ?? "engine.ai.native.other";
    merged.set(key, (merged.get(key) ?? 0) + n);
  }
  for (const [key, n] of merged) notes.push(t(key, { n }));
  return { pdf, notes, fonts };
}
