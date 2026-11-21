// SpreadsheetML styles.xml writer: appends the cell formats (xf) that sheet styles need — number format, font, fill,
// border, alignment — to an existing stylesheet (Office Surgeon) or to a fresh one, reusing what is already there.

import type { SheetBorder, SheetStyle } from "../../core/sheetTypes";
import { esc } from "../xml";

const BUILTIN_IDS: Record<string, number> = {
  General: 0, "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10, "0.00E+00": 11, "# ?/?": 12, "# ??/??": 13,
  "d-mmm-yy": 15, "d-mmm": 16, "mmm-yy": 17, "h:mm AM/PM": 18, "h:mm:ss AM/PM": 19, "h:mm": 20, "h:mm:ss": 21,
  "mm:ss": 45, "[h]:mm:ss": 46, "mm:ss.0": 47, "##0.0E+0": 48, "@": 49,
};

const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const argb = (c: string) => "FF" + c.replace("#", "").toUpperCase().padStart(6, "0");

export class StyleWriter {
  private add = { numFmts: [] as string[], fonts: [] as string[], fills: [] as string[], borders: [] as string[], cellXfs: [] as string[] };
  private counts: Record<string, number> = {};
  private numFmtIds = new Map<string, number>();
  private nextFmt = 164;
  private cache = new Map<string, number>();
  private found = new Map<string, Map<string, number>>();
  changed = false;

  constructor(
    private xml: string,
    private base: { font: string; size: number },
  ) {
    if (/<\w+:styleSheet\b/.test(xml)) throw new Error("prefixed stylesheet");
    for (const tag of ["numFmts", "fonts", "fills", "borders", "cellXfs"]) {
      const block = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
      const inner = block?.[1] ?? "";
      const el = tag === "numFmts" ? "numFmt" : tag === "fonts" ? "font" : tag === "fills" ? "fill" : tag === "borders" ? "border" : "xf";
      const items = inner.match(new RegExp(`<${el}\\b(?:[^>]*/>|[\\s\\S]*?</${el}>)`, "g")) ?? [];
      this.counts[tag] = items.length;
      this.found.set(tag, new Map(items.map((x, i) => [x.replace(/\s+/g, " "), i])));
    }
    for (const m of xml.matchAll(/<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"[^>]*\/>/g)) {
      this.numFmtIds.set(unesc(m[2]), Number(m[1]));
      this.nextFmt = Math.max(this.nextFmt, Number(m[1]) + 1);
    }
  }

  private put(tag: keyof StyleWriter["add"], x: string): number {
    const key = x.replace(/\s+/g, " ");
    const have = this.found.get(tag)!.get(key);
    if (have !== undefined) return have;
    const i = this.counts[tag]++;
    this.found.get(tag)!.set(key, i);
    this.add[tag].push(x);
    this.changed = true;
    return i;
  }

  private fmtId(code: string | undefined): number {
    if (!code || code === "General") return 0;
    if (BUILTIN_IDS[code] !== undefined) return BUILTIN_IDS[code];
    const have = this.numFmtIds.get(code);
    if (have !== undefined) return have;
    const id = this.nextFmt++;
    this.numFmtIds.set(code, id);
    this.add.numFmts.push(`<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`);
    this.counts.numFmts++;
    this.changed = true;
    return id;
  }

  /** Cell format index (cellXfs) for a sheet style. */
  xfFor(st: SheetStyle): number {
    const key = JSON.stringify(st);
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const font =
      "<font>" +
      (st.bold ? "<b/>" : "") +
      (st.italic ? "<i/>" : "") +
      (st.strike ? "<strike/>" : "") +
      (st.underline ? (st.underline === "double" ? '<u val="double"/>' : "<u/>") : "") +
      `<sz val="${st.size ?? this.base.size}"/>` +
      (st.color ? `<color rgb="${argb(st.color)}"/>` : '<color theme="1"/>') +
      `<name val="${esc(st.font ?? this.base.font)}"/>` +
      "</font>";
    const fontId = this.put("fonts", font);
    const fillId = st.fill ? this.put("fills", `<fill><patternFill patternType="solid"><fgColor rgb="${argb(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    const side = (n: string, b?: SheetBorder) => (b ? `<${n} style="${b.style}"><color rgb="${argb(b.color)}"/></${n}>` : `<${n}/>`);
    const borderId = st.bl || st.br || st.bt || st.bb ? this.put("borders", `<border>${side("left", st.bl)}${side("right", st.br)}${side("top", st.bt)}${side("bottom", st.bb)}<diagonal/></border>`) : 0;
    const numFmtId = this.fmtId(st.fmt);
    const al = [
      st.h ? ` horizontal="${st.h}"` : "",
      st.v ? ` vertical="${st.v}"` : "",
      st.wrap ? ' wrapText="1"' : "",
      st.shrink ? ' shrinkToFit="1"' : "",
      st.indent ? ` indent="${st.indent}"` : "",
      st.rot ? ` textRotation="${st.rot}"` : "",
    ].join("");
    const xf =
      `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
      (numFmtId ? ' applyNumberFormat="1"' : "") +
      (fontId ? ' applyFont="1"' : "") +
      (fillId ? ' applyFill="1"' : "") +
      (borderId ? ' applyBorder="1"' : "") +
      (al ? ` applyAlignment="1"><alignment${al}/></xf>` : "/>");
    const id = this.put("cellXfs", xf);
    this.cache.set(key, id);
    return id;
  }

  /** The stylesheet with the new entries appended (counts updated). */
  result(): string {
    let s = this.xml;
    for (const tag of ["numFmts", "fonts", "fills", "borders", "cellXfs"] as const) {
      const extra = this.add[tag];
      if (!extra.length) continue;
      const open = new RegExp(`<${tag}\\b[^>]*?(/?)>`).exec(s);
      if (!open) {
        if (tag !== "numFmts") throw new Error(`no ${tag}`);
        const root = /<styleSheet\b[^>]*>/.exec(s)!;
        const at = root.index + root[0].length;
        s = s.slice(0, at) + `<numFmts count="${extra.length}">${extra.join("")}</numFmts>` + s.slice(at);
        continue;
      }
      if (open[1]) {
        s = s.slice(0, open.index) + `<${tag} count="${this.counts[tag]}">${extra.join("")}</${tag}>` + s.slice(open.index + open[0].length);
        continue;
      }
      const close = s.indexOf(`</${tag}>`, open.index);
      s = s.slice(0, close) + extra.join("") + s.slice(close);
      const tagText = open[0];
      const fixed = /\scount="\d+"/.test(tagText) ? tagText.replace(/\scount="\d+"/, ` count="${this.counts[tag]}"`) : tagText.replace(new RegExp(`^<${tag}`), `<${tag} count="${this.counts[tag]}"`);
      s = s.slice(0, open.index) + fixed + s.slice(open.index + tagText.length);
    }
    return s;
  }
}

/** A minimal stylesheet for a fresh workbook (font 0 = the base font; fills 0/1 are the required none / gray125). */
export function freshStyles(font: string, size: number): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="${size}"/><color theme="1"/><name val="${esc(font)}"/></font></fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  );
}
