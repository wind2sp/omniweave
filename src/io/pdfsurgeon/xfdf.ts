// PDF Surgeon — comments as FDF / XFDF (Acrobat 주석 ▸ 내보내기 / 가져오기, ISO 32000-1 §12.7.8 and the XFDF spec).
// Export reads every comment of a PDF (markup, notes, stamps, lines / polygons, with their replies and review states)
// and writes it as XFDF (XML) or FDF (a small PDF-syntax file); import reads either back into a neutral list the
// editor turns into its own comments (ui/pdf/PdfComments.tsx).

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from "pdf-lib";
import { loadPdf } from "./acrobat";
import { parseRatio, ratioText, realPerPt, type MeasureRatio } from "./annots";
import { Lexer, PdfDict, PdfName, PdfRef, PdfStr, parseValue, serialize, type PdfVal } from "./syntax";

export interface XAnnot {
  page: number;
  /** Highlight · Underline · StrikeOut · Squiggly · Text · FreeText · Stamp · Line · PolyLine · Polygon · Ink … */
  subtype: string;
  rect: number[];
  color?: number[];
  contents?: string;
  author?: string;
  /** /NM — names a comment for its replies */
  name?: string;
  date?: string;
  quads?: number[];
  /** Line /L, PolyLine / Polygon /Vertices */
  points?: number[];
  /** the comment this is a reply / state of (its name) */
  inReplyTo?: string;
  state?: string;
  stateModel?: string;
  /** a measurement's scale (/Measure /R, XFDF <measure rateValue>) */
  scale?: MeasureRatio;
  /** /IT: LineDimension · PolygonDimension · PolyLineDimension (a measurement) */
  intent?: string;
}

const COMMENTS = new Set(["Text", "FreeText", "Highlight", "Underline", "StrikeOut", "Squiggly", "Square", "Circle", "Line", "Polygon", "PolyLine", "Ink", "Stamp", "Caret"]);
const txt = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);
const nums = (ctx: { lookup(o: unknown): unknown }, o: PDFObject | undefined) => {
  const v = ctx.lookup(o);
  return v instanceof PDFArray ? v.asArray().map((x) => (ctx.lookup(x) as PDFNumber)?.asNumber?.() ?? 0) : undefined;
};

/** Every comment of the file, replies pointing at their comment by name (one is given where the file has none). */
export async function readComments(bytes: Uint8Array): Promise<XAnnot[]> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const out: XAnnot[] = [];
  const nameOf = new Map<string, string>();
  let seq = 0;
  d.getPages().forEach((p, page) => {
    const arr = ctx.lookup(p.node.get(PDFName.of("Annots")));
    if (!(arr instanceof PDFArray)) return;
    for (const r of arr.asArray()) {
      const a = ctx.lookup(r);
      if (!(a instanceof PDFDict)) continue;
      const sub = (a.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() ?? "";
      if (!COMMENTS.has(sub)) continue;
      const name = txt(ctx.lookup(a.get(PDFName.of("NM"))) as PDFObject) ?? `omw-x${++seq}`;
      if (r instanceof PDFRef) nameOf.set(r.toString(), name);
      const irt = a.get(PDFName.of("IRT"));
      const lineL = nums(ctx, a.get(PDFName.of("L"))), vert = nums(ctx, a.get(PDFName.of("Vertices")));
      out.push({
        page,
        subtype: sub,
        rect: nums(ctx, a.get(PDFName.of("Rect"))) ?? [0, 0, 0, 0],
        color: nums(ctx, a.get(PDFName.of("C"))),
        contents: txt(ctx.lookup(a.get(PDFName.of("Contents"))) as PDFObject),
        author: txt(ctx.lookup(a.get(PDFName.of("T"))) as PDFObject),
        name,
        date: txt(ctx.lookup(a.get(PDFName.of("M"))) as PDFObject),
        quads: nums(ctx, a.get(PDFName.of("QuadPoints"))),
        points: lineL ?? vert,
        inReplyTo: irt instanceof PDFRef ? irt.toString() : undefined,
        state: txt(ctx.lookup(a.get(PDFName.of("State"))) as PDFObject),
        stateModel: txt(ctx.lookup(a.get(PDFName.of("StateModel"))) as PDFObject),
        scale: measureRatio(ctx.lookup(a.get(PDFName.of("Measure")))),
        intent: (a.get(PDFName.of("IT")) as PDFName | undefined)?.decodeText?.(),
      });
    }
  });
  for (const x of out) if (x.inReplyTo) x.inReplyTo = nameOf.get(x.inReplyTo) ?? x.inReplyTo;
  return out;
}

/** a /Measure dictionary's ratio (its /R text) */
function measureRatio(m: PDFObject | undefined): MeasureRatio | undefined {
  if (!(m instanceof PDFDict)) return undefined;
  return parseRatio(txt(m.get(PDFName.of("R")))) ?? undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hexColor = (c?: number[]) => (c && c.length === 3 ? "#" + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("").toUpperCase() : undefined);
const XTAG: Record<string, string> = { Text: "text", FreeText: "freetext", Highlight: "highlight", Underline: "underline", StrikeOut: "strikeout", Squiggly: "squiggly", Square: "square", Circle: "circle", Line: "line", Polygon: "polygon", PolyLine: "polyline", Ink: "ink", Stamp: "stamp", Caret: "caret" };
const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
/** a number format of a measure, as XFDF writes it (conversion c, precision d, unit u) */
const nfXml = (tag: string, u: string, c: number) => `<${tag} c="${Number(c.toPrecision(8))}" d="100" f="D" o="S" rd="." rt="" ss="" ps="" u="${esc(u)}"/>`;
/** XFDF <measure>: the scale ratio with its area, distance and x formats (Acrobat's rectilinear measure) */
const measureXml = (s: MeasureRatio) => `<measure rateValue="${esc(ratioText(s))}">${nfXml("area", "sq " + s.realUnit, 1)}${nfXml("distance", s.realUnit, 1)}${nfXml("xformat", s.realUnit, realPerPt(s))}</measure>`;
/** the same as an FDF /Measure dictionary */
const measureFdf = (s: MeasureRatio, str: (s: string) => string) => {
  const nf = (u: string, c: number) => `<< /Type /NumberFormat /U ${str(u)} /C ${Number(c.toPrecision(8))} /D 100 /F /D /RD (.) /RT () /SS () /O /S >>`;
  return `/Measure << /Type /Measure /Subtype /RL /R ${str(ratioText(s))} /X [${nf(s.realUnit, realPerPt(s))}] /D [${nf(s.realUnit, 1)}] /A [${nf("sq " + s.realUnit, 1)}] >>`;
};

export function toXfdf(list: XAnnot[], file: string): string {
  const items = list.map((a) => {
    const tag = XTAG[a.subtype] ?? "text";
    const attrs: [string, string | undefined][] = [
      ["page", String(a.page)],
      ["rect", a.rect.map(fmt).join(",")],
      ["color", hexColor(a.color)],
      ["name", a.name],
      ["title", a.author],
      ["date", a.date],
      ["coords", a.quads?.map(fmt).join(",")],
      ["inreplyto", a.inReplyTo],
      ["state", a.state],
      ["statemodel", a.stateModel],
      ["intent", a.intent],
    ];
    if (a.subtype === "Line" && a.points) attrs.push(["start", `${fmt(a.points[0])},${fmt(a.points[1])}`], ["end", `${fmt(a.points[2])},${fmt(a.points[3])}`]);
    const at = attrs.filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => ` ${k}="${esc(v!)}"`).join("");
    const verts = (a.subtype === "Polygon" || a.subtype === "PolyLine") && a.points ? `<vertices>${a.points.map(fmt).join(",")}</vertices>` : "";
    const measure = a.scale && a.points ? measureXml(a.scale) : "";
    return `<${tag}${at}>${a.contents ? `<contents>${esc(a.contents)}</contents>` : ""}${verts}${measure}</${tag}>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<annots>\n${items.join("\n")}\n</annots>\n<f href="${esc(file)}"/>\n</xfdf>\n`;
}

/** FDF 1.2: one dictionary per comment in /FDF /Annots, /Page its page, /IRT the object of its comment. */
export function toFdf(list: XAnnot[], file: string): Uint8Array {
  const objNo = new Map<string, number>();
  list.forEach((a, i) => a.name && objNo.set(a.name, i + 2));
  const str = (s: string) => serialize(new PdfStr(utf16(s), true));
  const objs = list.map((a, i) => {
    const d: string[] = [`/Type /Annot /Subtype /${a.subtype} /Page ${a.page} /Rect [${a.rect.map(fmt).join(" ")}]`];
    if (a.color) d.push(`/C [${a.color.map(fmt).join(" ")}]`);
    if (a.contents) d.push(`/Contents ${str(a.contents)}`);
    if (a.author) d.push(`/T ${str(a.author)}`);
    if (a.name) d.push(`/NM ${str(a.name)}`);
    if (a.date) d.push(`/M ${str(a.date)}`);
    if (a.quads) d.push(`/QuadPoints [${a.quads.map(fmt).join(" ")}]`);
    if (a.points) d.push(a.subtype === "Line" ? `/L [${a.points.slice(0, 4).map(fmt).join(" ")}]` : `/Vertices [${a.points.map(fmt).join(" ")}]`);
    if (a.inReplyTo && objNo.has(a.inReplyTo)) d.push(`/IRT ${objNo.get(a.inReplyTo)} 0 R`);
    if (a.state) d.push(`/State ${str(a.state)} /StateModel ${str(a.stateModel ?? "Review")}`);
    if (a.intent) d.push(`/IT /${a.intent}`);
    if (a.scale && a.points) d.push(measureFdf(a.scale, str));
    return `${i + 2} 0 obj\n<< ${d.join(" ")} >>\nendobj\n`;
  });
  const annots = list.map((_, i) => `${i + 2} 0 R`).join(" ");
  const head = `%FDF-1.2\n%âãÏÓ\n1 0 obj\n<< /FDF << /Annots [${annots}] /F ${str(file)} >> >>\nendobj\n`;
  const text = head + objs.join("") + "trailer\n<< /Root 1 0 R >>\n%%EOF\n";
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 255);
}

function utf16(s: string): Uint8Array {
  if (/^[\x20-\x7e]*$/.test(s)) return Uint8Array.from(s, (c) => c.charCodeAt(0));
  const out = [0xfe, 0xff];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c > 0xffff) {
      const h = 0xd800 + ((c - 0x10000) >> 10), l = 0xdc00 + ((c - 0x10000) & 0x3ff);
      out.push(h >> 8, h & 255, l >> 8, l & 255);
    } else out.push(c >> 8, c & 255);
  }
  return new Uint8Array(out);
}
function decodePdfText(b: Uint8Array): string {
  if (b[0] === 0xfe && b[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  return Array.from(b, (c) => String.fromCharCode(c)).join("");
}

// ───────── import ─────────

const attr = (tag: string, k: string) => {
  const m = new RegExp(`\\s${k}="([^"]*)"`, "i").exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") : undefined;
};
const numList = (s?: string) => (s ? s.split(/[,\s]+/).filter(Boolean).map(Number) : undefined);
const fromHex = (s?: string) => (s && /^#[0-9a-f]{6}$/i.test(s) ? [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16) / 255) : undefined);
const SUB_OF: Record<string, string> = Object.fromEntries(Object.entries(XTAG).map(([k, v]) => [v, k]));

export function parseXfdf(xml: string): XAnnot[] {
  const body = /<annots>([\s\S]*?)<\/annots>/i.exec(xml)?.[1] ?? "";
  const out: XAnnot[] = [];
  const re = /<([a-z]+)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/gi;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const sub = SUB_OF[m[1].toLowerCase()];
    if (!sub) continue;
    const tag = `<${m[1]}${m[2]}>`, inner = m[4] ?? "";
    const contents = /<contents>([\s\S]*?)<\/contents>/i.exec(inner)?.[1]?.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const start = numList(attr(tag, "start")), end = numList(attr(tag, "end"));
    const verts = numList(/<vertices>([\s\S]*?)<\/vertices>/i.exec(inner)?.[1]);
    out.push({
      page: Number(attr(tag, "page") ?? 0),
      subtype: sub,
      rect: numList(attr(tag, "rect")) ?? [0, 0, 0, 0],
      color: fromHex(attr(tag, "color")),
      contents,
      author: attr(tag, "title"),
      name: attr(tag, "name"),
      date: attr(tag, "date"),
      quads: numList(attr(tag, "coords")),
      points: start && end ? [...start, ...end] : verts,
      inReplyTo: attr(tag, "inreplyto"),
      state: attr(tag, "state"),
      stateModel: attr(tag, "statemodel"),
      intent: attr(tag, "intent"),
      scale: parseRatio(attr(/<measure\b[^>]*>/i.exec(inner)?.[0] ?? "", "rateValue")) ?? undefined,
    });
  }
  return out;
}

export function parseFdf(bytes: Uint8Array): XAnnot[] {
  const objs = new Map<number, PdfVal>();
  const lx = new Lexer(bytes);
  const toks: { n: number; v: PdfVal }[] = [];
  // "n g obj <value> endobj" — every object of the file
  for (;;) {
    const t = lx.next();
    if (t.k === "eof") break;
    if (t.k === "val" && typeof t.v === "number") {
      const save = lx.pos;
      const g = lx.next(), o = lx.next();
      if (g.k === "val" && typeof g.v === "number" && o.k === "kw" && o.v === "obj") {
        const v = parseValue(lx, true);
        toks.push({ n: t.v, v });
        continue;
      }
      lx.pos = save;
    }
  }
  for (const t of toks) objs.set(t.n, t.v);
  const get = (d: PdfVal, k: string) => (d instanceof PdfDict ? d.map.get(k) : undefined);
  const deref = (v: PdfVal | undefined): PdfVal | undefined => (v instanceof PdfRef ? objs.get(v.num) : v);
  const text = (v: PdfVal | undefined) => { const x = deref(v); return x instanceof PdfStr ? decodePdfText(x.bytes) : undefined; };
  const arr = (v: PdfVal | undefined) => { const x = deref(v); return Array.isArray(x) ? x.map((y) => (typeof deref(y) === "number" ? (deref(y) as number) : 0)) : undefined; };
  const root = [...objs.values()].find((v) => get(v, "FDF"));
  const list = deref(get(deref(get(root!, "FDF"))!, "Annots"));
  const out: XAnnot[] = [];
  const nameByObj = new Map<number, string>();
  if (!Array.isArray(list)) return out;
  for (const r of list) {
    const a = deref(r);
    const sub = deref(get(a!, "Subtype"));
    if (!(sub instanceof PdfName)) continue;
    const nm = text(get(a!, "NM")) ?? `omw-f${r instanceof PdfRef ? r.num : out.length}`;
    if (r instanceof PdfRef) nameByObj.set(r.num, nm);
    const irt = get(a!, "IRT");
    const L = arr(get(a!, "L")), V = arr(get(a!, "Vertices"));
    out.push({
      page: (deref(get(a!, "Page")) as number) ?? 0,
      subtype: sub.name,
      rect: arr(get(a!, "Rect")) ?? [0, 0, 0, 0],
      color: arr(get(a!, "C")),
      contents: text(get(a!, "Contents")),
      author: text(get(a!, "T")),
      name: nm,
      date: text(get(a!, "M")),
      quads: arr(get(a!, "QuadPoints")),
      points: L ?? V,
      inReplyTo: irt instanceof PdfRef ? String(irt.num) : undefined,
      state: text(get(a!, "State")),
      stateModel: text(get(a!, "StateModel")),
      intent: (deref(get(a!, "IT")) as PdfName | undefined)?.name,
      scale: parseRatio(text(get(deref(get(a!, "Measure"))!, "R"))) ?? undefined,
    });
  }
  for (const x of out) if (x.inReplyTo && /^\d+$/.test(x.inReplyTo)) x.inReplyTo = nameByObj.get(Number(x.inReplyTo)) ?? x.inReplyTo;
  return out;
}

/** XFDF or FDF, told apart by their first bytes. */
export function parseComments(bytes: Uint8Array): XAnnot[] {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 64));
  if (/%FDF-/.test(head)) return parseFdf(bytes);
  return parseXfdf(new TextDecoder().decode(bytes));
}
