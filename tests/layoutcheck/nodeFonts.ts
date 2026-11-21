// Test helper: a MeasureFn for Node that measures with the real font files installed on this PC, choosing
// fonts the way the app's WebView does with cssFont()'s family list: the first listed family that is installed
// (localized names such as "맑은 고딕" match too), per character, falling back down the list and finally to the
// bundled Pretendard web font (node_modules/pretendard) — what Omniweave draws with when a document's font
// is missing. Only local font files are read; nothing is downloaded.

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import fontkit from "@pdf-lib/fontkit";
import type { MeasureFn } from "../../src/core/text";

interface FaceRef {
  file: string;
  ps: string;
  families: string[];
  sub: string;
  bold: boolean;
  italic: boolean;
}

function readAt(fd: number, pos: number, len: number): Buffer {
  const b = Buffer.alloc(len);
  readSync(fd, b, 0, len, pos);
  return b;
}

/** Family / subfamily / PostScript names of every face in a font file (sfnt name table only). */
function faceNames(file: string): FaceRef[] {
  const fd = openSync(file, "r");
  try {
    const head = readAt(fd, 0, 12);
    const offsets: number[] = [];
    if (head.toString("latin1", 0, 4) === "ttcf") {
      const n = head.readUInt32BE(8);
      const t = readAt(fd, 12, 4 * n);
      for (let i = 0; i < n; i++) offsets.push(t.readUInt32BE(i * 4));
    } else offsets.push(0);
    const out: FaceRef[] = [];
    for (const off of offsets) {
      const d = readAt(fd, off, 12);
      const numTables = d.readUInt16BE(4);
      const dir = readAt(fd, off + 12, numTables * 16);
      let nameOff = -1, nameLen = 0;
      for (let i = 0; i < numTables; i++)
        if (dir.toString("latin1", i * 16, i * 16 + 4) === "name") {
          nameOff = dir.readUInt32BE(i * 16 + 8);
          nameLen = dir.readUInt32BE(i * 16 + 12);
        }
      if (nameOff < 0) continue;
      const nt = readAt(fd, nameOff, nameLen);
      const count = nt.readUInt16BE(2), strOff = nt.readUInt16BE(4);
      const names = new Map<number, Set<string>>();
      for (let i = 0; i < count; i++) {
        const r = 6 + i * 12;
        const pid = nt.readUInt16BE(r), eid = nt.readUInt16BE(r + 2), nid = nt.readUInt16BE(r + 6);
        const len = nt.readUInt16BE(r + 8), so = nt.readUInt16BE(r + 10);
        if (![1, 2, 4, 6, 16, 17].includes(nid)) continue;
        const raw = nt.subarray(strOff + so, strOff + so + len);
        let s = "";
        if (pid === 3 || pid === 0) for (let k = 0; k + 1 < raw.length; k += 2) s += String.fromCharCode(raw.readUInt16BE(k));
        else if (pid === 1 && eid === 0) s = raw.toString("latin1");
        else continue;
        if (!names.has(nid)) names.set(nid, new Set());
        names.get(nid)!.add(s.trim());
      }
      const fam = [...(names.get(16) ?? []), ...(names.get(1) ?? [])];
      const sub = [...(names.get(17) ?? names.get(2) ?? [])][0] ?? "Regular";
      out.push({
        file,
        ps: [...(names.get(6) ?? [])][0] ?? "",
        families: [...new Set(fam.map((f) => f.toLowerCase()))],
        sub,
        bold: /bold|black|heavy|extrabold/i.test(sub),
        italic: /italic|oblique/i.test(sub),
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    closeSync(fd);
  }
}

let index: FaceRef[] | null = null;
function fontIndex(): FaceRef[] {
  if (index) return index;
  const dirs = [
    "C:/Windows/Fonts",
    join(process.env.LOCALAPPDATA ?? "", "Microsoft/Windows/Fonts"),
  ];
  index = [];
  for (const d of dirs) {
    if (!d || !existsSync(d)) continue;
    for (const f of readdirSync(d)) if (/\.(ttf|otf|ttc)$/i.test(f)) index.push(...faceNames(join(d, f)));
  }
  // bundled web font (src/ui/styles.css @font-face Pretendard)
  const pre = join(process.cwd(), "node_modules/pretendard/dist/public/static/alternative");
  for (const w of ["Regular", "Bold"]) {
    const f = join(pre, `Pretendard-${w}.ttf`);
    if (existsSync(f)) index.push({ file: f, ps: `Pretendard-${w}`, families: ["pretendard"], sub: w, bold: w === "Bold", italic: false });
  }
  return index;
}

const loaded = new Map<string, any>();
function loadFace(ref: FaceRef): any {
  const key = ref.file + "|" + ref.ps;
  let f = loaded.get(key);
  if (!f) {
    const bytes = readFileSync(ref.file);
    f = fontkit.create(bytes as any, /\.ttc$/i.test(ref.file) ? ref.ps : undefined);
    loaded.set(key, f);
  }
  return f;
}

/** Installed face for a CSS family name, weight and style (null when not installed). */
export function findFace(family: string, bold = false, italic = false): any | null {
  const fam = family.trim().replace(/^["']|["']$/g, "").toLowerCase();
  const generic: Record<string, string> = { "sans-serif": "malgun gothic", serif: "batang", monospace: "consolas" };
  const want = generic[fam] ?? fam;
  const faces = fontIndex().filter((f) => f.families.includes(want));
  if (!faces.length) return null;
  const pick = faces.find((f) => f.bold === bold && f.italic === italic) ?? faces.find((f) => f.bold === bold && !f.italic) ?? faces.find((f) => !f.bold && !f.italic) ?? faces[0];
  return loadFace(pick);
}

export const isInstalled = (family: string) => fontIndex().some((f) => f.families.includes(family.trim().toLowerCase()));

function parseFont(font: string) {
  const m = /^(italic\s+)?(\d+)\s+([\d.]+)px\s+(.*)$/.exec(font.trim());
  if (!m) return { italic: false, bold: false, size: 16, families: ["pretendard"] };
  return { italic: !!m[1], bold: Number(m[2]) >= 600, size: Number(m[3]), families: m[4].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")) };
}

/**
 * Advance width of text drawn with the CSS font string, per-character fallback through the family list.
 * Sums glyph advances (hmtx) without kerning — fast enough for thousands of layouts; Hangul fonts carry no
 * Hangul kerning, Latin pair kerning is the only thing lost against the WebView's canvas.
 */
export function nodeMeasure(): MeasureFn {
  const perFont = new Map<string, { size: number; adv: Map<number, number>; faces: any[] }>();
  return (text, font) => {
    let e = perFont.get(font);
    if (!e) {
      const f = parseFont(font);
      e = { size: f.size, adv: new Map(), faces: f.families.map((fam) => findFace(fam, f.bold, f.italic)).filter(Boolean) };
      perFont.set(font, e);
    }
    if (!e.faces.length) return text.length * e.size * 0.5;
    let w = 0;
    for (const ch of text) {
      // canvas measureText replaces ASCII whitespace (tab, line feed …) with U+0020
      let cp = ch.codePointAt(0)!;
      if (cp === 9 || cp === 10 || cp === 12 || cp === 13) cp = 32;
      let a = e.adv.get(cp);
      if (a === undefined) {
        const face = e.faces.find((x) => x.hasGlyphForCodePoint(cp)) ?? e.faces[e.faces.length - 1];
        a = (face.glyphForCodePoint(cp).advanceWidth / face.unitsPerEm) * e.size;
        e.adv.set(cp, a);
      }
      w += a;
    }
    return w;
  };
}
