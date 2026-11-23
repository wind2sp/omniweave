// ODP (OpenDocument Presentation — LibreOffice Impress, Google Slides' "Download as ODP") opened as slides (실사용 점검
// 2026-11-23 #65: listed as a slide format, but opening said "unsupported format"). What is read: the slide size, each
// slide's background colour, text frames (titles, outlines, text boxes — paragraphs with size, bold, italic, underline,
// colour, font and alignment, list items as bullets), pictures, rectangles / ellipses / lines and custom shapes as
// their box with fill and outline, and the speaker notes. Saving goes to PPTX / PDF (no ODP writer).

import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../core/assets";
import { corner, ellipseContour, rectContour } from "../../core/vector";
import { newImage, newPage, newParagraph, newText, newVector, type Align, type AssetRef, type Page, type SceneNode, type TextParagraph, type TextRun } from "../../core/types";
import { attr, child, children, descendants, parseXml, textOf } from "../xml";
import { imageMime } from "./sniff";

/** An ODF length ("2.5cm", "12pt", "0.3in", "10mm", "96px") in CSS px; `def` when absent or unreadable. */
export function odfLength(v: string | null | undefined, def = 0): number {
  const m = v && /^\s*(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?\s*$/.exec(v);
  if (!m) return def;
  const n = Number(m[1]);
  switch (m[2]) {
    case "cm":
      return (n * 96) / 2.54;
    case "mm":
      return (n * 96) / 25.4;
    case "in":
      return n * 96;
    case "pt":
      return (n * 96) / 72;
    case "pc":
      return n * 16;
    default:
      return n;
  }
}

type Props = Record<string, string>;
/** Named styles (automatic and common, content.xml + styles.xml): their properties with the parent's underneath. */
function styleTable(docs: Document[]) {
  const raw = new Map<string, { parent?: string; props: Props }>();
  for (const d of docs)
    for (const s of descendants(d.documentElement, "style")) {
      const name = attr(s, "name");
      if (!name || raw.has(name)) continue;
      const props: Props = {};
      for (const p of children(s))
        if (/-properties$/.test(p.localName ?? p.nodeName))
          for (let i = 0; i < p.attributes.length; i++) {
            const a = p.attributes[i];
            props[a.localName ?? a.name.split(":").pop()!] = a.value;
          }
      raw.set(name, { parent: attr(s, "parent-style-name") ?? undefined, props });
    }
  const memo = new Map<string, Props>();
  const get = (name: string | null | undefined, depth = 0): Props => {
    if (!name || depth > 12) return {};
    const hit = memo.get(name);
    if (hit) return hit;
    const s = raw.get(name);
    const out = s ? { ...get(s.parent, depth + 1), ...s.props } : {};
    memo.set(name, out);
    return out;
  };
  return get;
}

const ALIGN: Record<string, Align> = { center: "CENTER", end: "RIGHT", right: "RIGHT", justify: "JUSTIFY" as Align, start: "LEFT", left: "LEFT" };
const colorOf = (v: string | undefined) => (v && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);

function runOf(p: Props, base: Partial<TextRun>): Partial<TextRun> {
  const r: Partial<TextRun> = { ...base };
  if (p["font-size"] && !p["font-size"].endsWith("%")) r.fontSize = odfLength(p["font-size"], r.fontSize ?? 24);
  if (p["font-weight"]) r.bold = p["font-weight"] === "bold" || Number(p["font-weight"]) >= 600;
  if (p["font-style"]) r.italic = p["font-style"] === "italic" || p["font-style"] === "oblique";
  if (p["text-underline-style"]) r.underline = p["text-underline-style"] !== "none";
  if (p["text-line-through-style"] && p["text-line-through-style"] !== "none") r.strike = true;
  const c = colorOf(p.color);
  if (c) r.color = c;
  const face = p["font-name"] ?? p["font-family"] ?? p["font-name-asian"] ?? p["font-family-asian"];
  if (face) r.fontFamily = face.replace(/^['"]|['"]$/g, "");
  return r;
}

/** The paragraphs of a text frame / shape (text:p, text:h, list items with a bullet). */
function paragraphsOf(box: Element, style: (n: string | null | undefined) => Props, base: Partial<TextRun>): TextParagraph[] {
  const out: TextParagraph[] = [];
  const para = (p: Element, bullet: string) => {
    const ps = style(attr(p, "style-name"));
    const pr = runOf(ps, base);
    const runs: TextRun[] = [];
    const walk = (el: Element, r: Partial<TextRun>) => {
      for (let c = el.firstChild; c; c = c.nextSibling) {
        if (c.nodeType === 3 || c.nodeType === 4) {
          if (c.nodeValue) runs.push({ ...newParagraph("", r).runs[0], text: c.nodeValue });
          continue;
        }
        if (c.nodeType !== 1) continue;
        const e = c as Element;
        const ln = e.localName ?? e.nodeName.split(":").pop();
        if (ln === "span" || ln === "a") walk(e, runOf(style(attr(e, "style-name")), r));
        else if (ln === "s") runs.push({ ...newParagraph("", r).runs[0], text: " ".repeat(Number(attr(e, "c") ?? 1) || 1) });
        else if (ln === "tab") runs.push({ ...newParagraph("", r).runs[0], text: "\t" });
        else if (ln === "line-break") runs.push({ ...newParagraph("", r).runs[0], text: "\n" });
        else if (ln !== "note" && ln !== "annotation") walk(e, r);
      }
    };
    walk(p, pr);
    const q = newParagraph("", pr, ALIGN[ps["text-align"] ?? ""] ?? "LEFT");
    if (bullet) runs.unshift({ ...q.runs[0], text: bullet });
    if (runs.length) q.runs = runs;
    q.lineSpacing = 1.2;
    q.spaceAfter = 4;
    out.push(q);
  };
  const walkBox = (el: Element, depth: number) => {
    for (const c of children(el)) {
      const ln = c.localName ?? c.nodeName.split(":").pop();
      if (ln === "p" || ln === "h") para(c, depth ? "• " : "");
      else if (ln === "list") for (const it of children(c)) walkBox(it, depth + 1);
      else if (ln === "list-item" || ln === "list-header") walkBox(c, depth);
    }
  };
  walkBox(box, 0);
  return out;
}

export interface OdpResult {
  pages: Page[];
  assets: Record<string, AssetRef>;
  /** things not read (e.g. charts, embedded objects), for the open notice */
  skipped: number;
}

export function importOdp(bytes: Uint8Array, name: string): OdpResult {
  const zip = unzipSync(bytes);
  const text = (p: string) => (zip[p] ? strFromU8(zip[p]) : null);
  const content = text("content.xml");
  if (!content) throw new Error("content.xml missing");
  const cdoc = parseXml(content);
  const sdoc = text("styles.xml") ? parseXml(text("styles.xml")!) : null;
  const style = styleTable(sdoc ? [cdoc, sdoc] : [cdoc]);
  // slide size: the page layout the first master page uses (else the first page layout)
  const layouts = new Map<string, Props>();
  for (const d of sdoc ? [sdoc, cdoc] : [cdoc])
    for (const pl of descendants(d.documentElement, "page-layout")) {
      const pp = child(pl, "page-layout-properties");
      if (pp) layouts.set(attr(pl, "name") ?? "", { w: attr(pp, "page-width") ?? "", h: attr(pp, "page-height") ?? "" });
    }
  const master = sdoc ? descendants(sdoc.documentElement, "master-page")[0] : undefined;
  const lay = (master && layouts.get(attr(master, "page-layout-name") ?? "")) ?? [...layouts.values()][0];
  const W = Math.round(odfLength(lay?.w, 1280)), H = Math.round(odfLength(lay?.h, 720));
  const assets: Record<string, AssetRef> = {};
  let skipped = 0;
  const pictures = new Map<string, AssetRef>();
  const picture = (href: string): AssetRef | null => {
    const path = href.replace(/^\.\//, "");
    if (pictures.has(path)) return pictures.get(path)!;
    const b = zip[path];
    const mime = b && imageMime(b);
    if (!b || !mime) return null;
    const a = makeAsset(b, mime, path.split("/").pop() ?? path);
    assets[a.id] = a;
    pictures.set(path, a);
    return a;
  };

  const pres = descendants(cdoc.documentElement, "presentation")[0];
  const slides = pres ? children(pres, "page") : [];
  const pages: Page[] = [];
  slides.forEach((sl, si) => {
    // named as the PPTX importer names slides ("deck - 1"): the tab shows the file name, not a slide's
    const page = newPage("SLIDE", W, H, `${name.replace(/\.[^.]+$/, "")} - ${si + 1}`);
    const bg = colorOf(style(attr(sl, "style-name"))["fill-color"]);
    page.background = bg && style(attr(sl, "style-name")).fill !== "none" ? bg : "#ffffff";
    page.source = { format: "odp", name };
    const nodes: SceneNode[] = [];
    const box = (el: Element) => ({ x: odfLength(attr(el, "x")), y: odfLength(attr(el, "y")), w: odfLength(attr(el, "width")), h: odfLength(attr(el, "height")) });
    const textNode = (el: Element, b: { x: number; y: number; w: number; h: number }, cls: string | null, gp: Props) => {
      const base: Partial<TextRun> = { fontSize: cls === "title" ? 44 * (96 / 72) : cls === "subtitle" ? 32 * (96 / 72) : 18 * (96 / 72), color: "#000000" };
      const paras = paragraphsOf(el, style, runOf(gp, base));
      if (!paras.length || !paras.some((p) => p.runs.some((r) => r.text.trim()))) return;
      const n = newText("", Math.max(8, b.w));
      n.paragraphs = paras;
      n.name = cls ?? "Text";
      n.transform = { x: b.x, y: b.y, rotation: 0, scale: 1 };
      nodes.push(n);
    };
    const shape = (el: Element, kind: "rect" | "ellipse" | "line") => {
      const gp = style(attr(el, "style-name"));
      if (kind === "line") {
        const x1 = odfLength(attr(el, "x1")), y1 = odfLength(attr(el, "y1")), x2 = odfLength(attr(el, "x2")), y2 = odfLength(attr(el, "y2"));
        const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(x2 - x1, y2 - y1)] }], "Line");
        v.fill = null;
        v.stroke = colorOf(gp["stroke-color"]) ?? "#000000";
        v.strokeWidth = Math.max(0.75, odfLength(gp["stroke-width"], 1));
        v.transform = { x: x1, y: y1, rotation: 0, scale: 1 };
        nodes.push(v);
        return;
      }
      const b = box(el);
      if (b.w <= 0 || b.h <= 0) return;
      const fill = gp.fill === "none" ? null : (colorOf(gp["fill-color"]) ?? (gp.fill === "solid" ? "#729fcf" : null));
      const stroke = gp.stroke === "none" ? null : (colorOf(gp["stroke-color"]) ?? (gp.stroke ? "#3465a4" : null));
      if (fill || stroke) {
        const v = newVector([kind === "ellipse" ? ellipseContour(b.w / 2, b.h / 2, b.w / 2, b.h / 2) : rectContour(0, 0, b.w, b.h)], attr(el, "name") ?? (kind === "ellipse" ? "Ellipse" : "Rectangle"));
        v.fill = fill;
        v.stroke = stroke;
        v.strokeWidth = stroke ? Math.max(0.75, odfLength(gp["stroke-width"], 1)) : 0;
        v.transform = { x: b.x, y: b.y, rotation: 0, scale: 1 };
        nodes.push(v);
      }
      // the shape's own text, centred in it as Impress shows it
      if (descendants(el, "p").length) {
        const before = nodes.length;
        textNode(el, b, null, gp);
        const t = nodes[before];
        if (t && t.type === "TEXT") for (const p of t.paragraphs) if (p.align === "LEFT") p.align = "CENTER";
      }
    };
    for (const el of children(sl)) {
      const ln = el.localName ?? el.nodeName.split(":").pop();
      if (ln === "frame") {
        const b = box(el);
        const cls = attr(el, "class");
        const tb = child(el, "text-box");
        const img = child(el, "image");
        if (tb) textNode(tb, b, cls, style(attr(el, "style-name")));
        else if (img) {
          const a = picture(attr(img, "href") ?? "");
          if (a && b.w > 0 && b.h > 0) {
            const n = newImage(a.id, b.w, b.h, attr(el, "name") ?? "Picture");
            n.transform = { x: b.x, y: b.y, rotation: 0, scale: 1 };
            nodes.push(n);
          } else skipped++;
        } else skipped++;
      } else if (ln === "rect" || ln === "custom-shape") {
        const geo = child(el, "enhanced-geometry");
        shape(el, geo && /ellipse|circle/.test(attr(geo, "type") ?? "") ? "ellipse" : "rect");
      } else if (ln === "ellipse" || ln === "circle") shape(el, "ellipse");
      else if (ln === "line") shape(el, "line");
      else if (ln === "notes") {
        const t = descendants(el, "text-box")
          .map((b) => descendants(b, "p").map(textOf).join("\n"))
          .join("\n")
          .trim();
        if (t) page.notes = t;
      } else if (ln !== "forms" && ln !== "animations") skipped++;
    }
    page.nodes = nodes;
    pages.push(page);
  });
  if (!pages.length) throw new Error("no slides");
  return { pages, assets, skipped };
}
