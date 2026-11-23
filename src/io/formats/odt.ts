// OpenDocument Text (.odt, LibreOffice / OpenOffice / 한글 ODT): content.xml's body as document pages — headings,
// paragraphs with their character formats (bold, italic, underline, strike, size, colour, font), alignment, lists
// (bullets / numbers, nested), tables (merged cells), pictures (draw:frame / draw:image) and page breaks; the page size
// and margins of the first master page. Notes are kept as their citation mark, tracked changes as their current text.
// Encrypted files (manifest:encryption-data) are refused. Saved as DOCX (no ODT writer).

import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../core/assets";
import { DEFAULT_MARGINS } from "../../core/pageSetup";
import type { AssetRef, Page, PageMargins, ParaRole, TableCell, TextParagraph, TextRun } from "../../core/types";
import { t } from "../../i18n";
import { attr, children, descendants, parseXml } from "../xml";
import { flowBlocks, paraRuns, type Block } from "./flow";
import { imageMime, imageSize } from "./sniff";
import { baseName } from "./text";

const PT = 96 / 72;

/** an ODF length ("2cm", "12pt", "1in", "10mm", "0.5pc") in px */
export function odfLength(v: string | null | undefined): number | null {
  const m = v ? /^\s*(-?[\d.]+)\s*(cm|mm|in|pt|pc|px)?\s*$/.exec(v) : null;
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const k = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: PT, pc: 16, px: 1 }[(m[2] ?? "px") as "px"];
  return n * k;
}

interface Look {
  run: Partial<TextRun>;
  align?: TextParagraph["align"];
  indent?: number;
  spaceAfter?: number;
  spaceBefore?: number;
  breakBefore?: boolean;
  parent?: string;
  /** a heading style (style:default-outline-level) */
  outline?: number;
  /** a list style's levels: numbered (how many levels its number shows, prefix, suffix) or bullets */
  listLevels?: { num: boolean; display: number; prefix: string; suffix: string }[];
}

const ALIGN: Record<string, TextParagraph["align"]> = { center: "CENTER", end: "RIGHT", right: "RIGHT", justify: "JUSTIFY", start: "LEFT", left: "LEFT" };

function readStyles(root: Element | undefined, out: Map<string, Look>, fonts: Map<string, string>) {
  if (!root) return;
  for (const ff of descendants(root, "font-face")) {
    const n = attr(ff, "name");
    const fam = attr(ff, "font-family")?.replace(/^'|'$/g, "");
    if (n && fam) fonts.set(n, fam);
  }
  for (const s of [...descendants(root, "style"), ...descendants(root, "default-style")]) {
    const name = s.localName === "default-style" ? `default:${attr(s, "family") ?? ""}` : attr(s, "name");
    if (!name) continue;
    const look: Look = { run: {} };
    const par = attr(s, "parent-style-name");
    if (par) look.parent = par;
    const ol = Number(attr(s, "default-outline-level"));
    if (ol >= 1 && ol <= 9) look.outline = ol;
    const tp = children(s, "text-properties")[0];
    if (tp) {
      const w = attr(tp, "font-weight");
      if (w) look.run.bold = w === "bold" || Number(w) >= 600;
      const st = attr(tp, "font-style");
      if (st) look.run.italic = st === "italic" || st === "oblique";
      const u = attr(tp, "text-underline-style");
      if (u) look.run.underline = u !== "none";
      const lt = attr(tp, "text-line-through-style");
      if (lt && lt !== "none") look.run.strike = true;
      const size = attr(tp, "font-size");
      const px = size && !size.endsWith("%") ? odfLength(size) : null;
      if (px) look.run.fontSize = px;
      const c = attr(tp, "color");
      if (c && /^#[0-9a-f]{6}$/i.test(c)) look.run.color = c;
      const bg = attr(tp, "background-color");
      if (bg && /^#[0-9a-f]{6}$/i.test(bg)) look.run.highlight = bg;
      const fn = attr(tp, "font-name") ?? attr(tp, "font-name-asian");
      const fam = fn ? fonts.get(fn) ?? fn : attr(tp, "font-family")?.replace(/^'|'$/g, "");
      if (fam) look.run.fontFamily = fam;
      const pos = attr(tp, "text-position");
      if (pos && /^super/.test(pos)) look.run.script = "super";
      else if (pos && (/^sub/.test(pos) || /^-/.test(pos))) look.run.script = "sub";
    }
    const pp = children(s, "paragraph-properties")[0];
    if (pp) {
      const a = attr(pp, "text-align");
      if (a && ALIGN[a]) look.align = ALIGN[a];
      const ml = odfLength(attr(pp, "margin-left"));
      if (ml) look.indent = ml;
      const mb = odfLength(attr(pp, "margin-bottom"));
      if (mb != null) look.spaceAfter = mb;
      const mt = odfLength(attr(pp, "margin-top"));
      if (mt) look.spaceBefore = mt;
      if (attr(pp, "break-before") === "page") look.breakBefore = true;
    }
    out.set(name, look);
  }
  for (const ls of descendants(root, "list-style")) {
    const name = attr(ls, "name");
    if (!name) continue;
    const levels: NonNullable<Look["listLevels"]> = [];
    for (const lv of children(ls)) {
      const n = Number(attr(lv, "level") ?? "1") - 1;
      const num = lv.localName === "list-level-style-number" && !!attr(lv, "num-format");
      if (n >= 0 && n < 10) levels[n] = { num, display: Math.max(1, Number(attr(lv, "display-levels") ?? "1") || 1), prefix: attr(lv, "num-prefix") ?? "", suffix: attr(lv, "num-suffix") ?? (num ? "." : "") };
    }
    out.set(`list:${name}`, { run: {}, listLevels: levels });
  }
}

export interface OdtImport {
  pages: Page[];
  assets: Record<string, AssetRef>;
  paragraphs: number;
  tables: number;
  pictures: number;
}

export function importOdt(bytes: Uint8Array, name: string): OdtImport {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(t("engine.odt.notOdt"));
  }
  const manifest = files["META-INF/manifest.xml"];
  if (manifest && /encryption-data/.test(strFromU8(manifest))) throw new Error(t("engine.odt.encrypted"));
  const content = files["content.xml"];
  if (!content) throw new Error(t("engine.odt.notOdt"));
  const doc = parseXml(strFromU8(content));
  const stylesDoc = files["styles.xml"] ? parseXml(strFromU8(files["styles.xml"])) : null;
  const looks = new Map<string, Look>();
  const fonts = new Map<string, string>();
  readStyles(stylesDoc?.documentElement, looks, fonts);
  readStyles(doc.documentElement, looks, fonts);

  /** the merged look of a style with its parents (and the family's default) */
  const lookOf = (style: string | null, family: "paragraph" | "text"): Look => {
    const chain: Look[] = [];
    let s = style;
    for (let k = 0; s && k < 20; k++) {
      const l = looks.get(s);
      if (!l) break;
      chain.unshift(l);
      s = l.parent ?? null;
    }
    const def = looks.get(`default:${family}`);
    if (def) chain.unshift(def);
    const out: Look = { run: {} };
    for (const l of chain) {
      Object.assign(out.run, l.run);
      for (const k of ["align", "indent", "spaceAfter", "spaceBefore", "breakBefore", "outline"] as const) if (l[k] !== undefined) (out as any)[k] = l[k];
    }
    return out;
  };

  // page size and margins: the first master page's layout (styles.xml)
  let width: number | undefined, height: number | undefined, margins: PageMargins | undefined;
  const master = stylesDoc ? descendants(stylesDoc, "master-page")[0] : undefined;
  const layoutName = master && attr(master, "page-layout-name");
  const layout = stylesDoc && layoutName ? descendants(stylesDoc, "page-layout").find((l) => attr(l, "name") === layoutName) : undefined;
  const plp = layout && children(layout, "page-layout-properties")[0];
  if (plp) {
    const w = odfLength(attr(plp, "page-width")), h = odfLength(attr(plp, "page-height"));
    if (w && h && w > 100 && h > 100) {
      width = w;
      height = h;
      const m = (k: string) => Math.max(0, odfLength(attr(plp, `margin-${k}`)) ?? 76);
      margins = { ...DEFAULT_MARGINS, top: m("top"), right: m("right"), bottom: m("bottom"), left: m("left") };
    }
  }

  const assets: Record<string, AssetRef> = {};
  const byPath = new Map<string, AssetRef | null>();
  const blocks: Block[] = [];
  let paragraphs = 0, tables = 0, pictures = 0;

  const imageBlock = (frame: Element): Block | null => {
    const img = descendants(frame, "image")[0];
    const href = img && attr(img, "href");
    if (!href || /^[a-z]+:/i.test(href)) return null;
    const p = href.replace(/^\.\//, "");
    let a = byPath.get(p);
    if (a === undefined) {
      const b = files[p];
      const mime = b ? imageMime(b) : null;
      a = b && mime && mime !== "image/tiff" ? makeAsset(b, mime, p.split("/").pop() ?? "image") : null;
      if (a) assets[a.id] = a;
      byPath.set(p, a);
    }
    if (!a) return null;
    const nat = imageSize(files[p]) ?? { width: 400, height: 300 };
    const w = odfLength(attr(frame, "width")) ?? nat.width;
    const h = odfLength(attr(frame, "height")) ?? (nat.height * w) / Math.max(1, nat.width);
    pictures++;
    return { kind: "image", assetId: a.id, width: w, height: h, name: attr(frame, "name") ?? a.name };
  };

  /** the runs of a paragraph (spans, spaces, tabs, line breaks, links, note marks); pictures in it go after it */
  const runsOf = (el: Element, base: Partial<TextRun>, out: Partial<TextRun>[], pics: Block[]) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === 3 || c.nodeType === 4) {
        const text = (c.nodeValue ?? "").replace(/[\r\n\t ]+/g, " ");
        if (text) out.push({ ...base, text });
        continue;
      }
      if (c.nodeType !== 1) continue;
      const e = c as Element;
      switch (e.localName) {
        case "span":
          runsOf(e, { ...base, ...lookOf(attr(e, "style-name"), "text").run }, out, pics);
          break;
        case "a":
        case "bookmark-ref":
        case "reference-ref":
        case "sequence":
        case "page-number":
        case "page-count":
        case "date":
        case "time":
        case "title":
        case "author-name":
        case "chapter":
        case "meta":
        case "ruby-base":
          runsOf(e, base, out, pics);
          break;
        case "s":
          out.push({ ...base, text: " ".repeat(Math.max(1, Number(attr(e, "c") ?? "1") || 1)) });
          break;
        case "tab":
          out.push({ ...base, text: "\t" });
          break;
        case "line-break":
          out.push({ ...base, text: "\n" });
          break;
        case "note": {
          const cit = children(e, "note-citation")[0];
          const mark = cit ? cit.textContent ?? "" : "";
          if (mark) out.push({ ...base, text: mark, script: "super" });
          break;
        }
        case "frame": {
          const b = imageBlock(e);
          if (b) pics.push(b);
          else for (const tb of descendants(e, "text-box")) for (const p of children(tb)) if (p.localName === "p") runsOf(p, base, out, pics);
          break;
        }
        case "tracked-changes":
        case "annotation":
        case "deletion":
        case "change-start":
        case "change-end":
        case "change":
        case "soft-page-break":
        case "bookmark":
        case "bookmark-start":
        case "bookmark-end":
          break;
        default:
          runsOf(e, base, out, pics);
      }
    }
  };

  const HEADING: Record<number, number> = { 1: 24 * PT, 2: 18 * PT, 3: 14 * PT, 4: 12 * PT, 5: 11 * PT, 6: 11 * PT };

  /** a text:p / text:h as a paragraph (+ the pictures it holds) */
  const paraBlocks = (el: Element, list?: { depth: number; numbered: boolean; label: string; first: boolean }): Block[] => {
    const look = lookOf(attr(el, "style-name"), "paragraph");
    const level = el.localName === "h" ? Math.min(6, Math.max(1, Number(attr(el, "outline-level") ?? look.outline ?? 1) || 1)) : look.outline ? Math.min(6, look.outline) : 0;
    const base: Partial<TextRun> = { fontSize: 12 * PT, ...(level ? { fontSize: HEADING[level], bold: true } : {}), ...look.run };
    const runs: Partial<TextRun>[] = [];
    const pics: Block[] = [];
    runsOf(el, base, runs, pics);
    // (leading / trailing collapsed whitespace of the XML)
    if (runs.length) {
      runs[0] = { ...runs[0], text: runs[0].text!.replace(/^ +/, "") };
      const l = runs.length - 1;
      runs[l] = { ...runs[l], text: runs[l].text!.replace(/ +$/, "") };
    }
    let role: ParaRole | undefined = level ? (("h" + level) as ParaRole) : undefined;
    const extra: Partial<TextParagraph> = { lineSpacing: 1.3, spaceAfter: look.spaceAfter ?? (level ? 8 : 6) };
    if (look.align) extra.align = look.align;
    if (look.indent) extra.indent = look.indent;
    if (look.spaceBefore) extra.spaceBefore = look.spaceBefore;
    if (list && level) {
      // a numbered heading (Word / LibreOffice outline numbering): a heading still, with its number
      if (list.first && list.numbered) runs.unshift({ ...base, text: list.label });
    } else if (list) {
      role = list.numbered ? "oli" : "li";
      extra.indent = 14 + list.depth * 22;
      extra.spaceAfter = 3;
      if (list.first) runs.unshift({ ...base, text: list.numbered ? list.label : "• " });
    }
    if (role) extra.role = role;
    const out: Block[] = [];
    if (look.breakBefore && blocks.length) out.push({ kind: "pagebreak" });
    const hasText = runs.some((r) => r.text);
    if (hasText || !pics.length) {
      out.push({ kind: "para", para: paraRuns(runs.length ? runs : [{ ...base, text: "" }], extra) });
      paragraphs++;
    }
    out.push(...pics);
    return out;
  };

  const tableBlock = (tbl: Element): Block => {
    tables++;
    const rowsEl: Element[] = [];
    const header: Element[] = [];
    const collect = (e: Element, into: Element[]) => {
      for (const c of children(e)) {
        if (c.localName === "table-row") into.push(c);
        else if (c.localName === "table-header-rows") collect(c, header);
        else if (c.localName === "table-rows" || c.localName === "table-row-group") collect(c, into);
      }
    };
    collect(tbl, rowsEl);
    const all = [...header, ...rowsEl];
    const rows: TableCell[][] = all.map((tr) => {
      const out: TableCell[] = [];
      for (const tc of children(tr)) {
        if (tc.localName !== "table-cell" && tc.localName !== "covered-table-cell") continue;
        const rep = Math.min(64, Number(attr(tc, "number-columns-repeated") ?? "1") || 1);
        for (let k = 0; k < rep; k++) {
          if (tc.localName === "covered-table-cell") {
            out.push({ text: "" });
            continue;
          }
          const ps: TextParagraph[] = [];
          for (const p of children(tc)) if (p.localName === "p" || p.localName === "h") for (const b of paraBlocks(p)) if (b.kind === "para") ps.push(b.para);
          paragraphs -= ps.length;
          const cell: TableCell = { text: ps.map((p) => p.runs.map((r) => r.text).join("")).join("\n") };
          if (ps.length) cell.richText = ps;
          const cs = Number(attr(tc, "number-columns-spanned") ?? "1"), rs = Number(attr(tc, "number-rows-spanned") ?? "1");
          if (cs > 1) cell.colSpan = cs;
          if (rs > 1) cell.rowSpan = rs;
          if (ps.length && ps.every((p) => p.runs.every((r) => !r.text || r.bold))) cell.bold = true;
          out.push(cell);
        }
      }
      return out;
    });
    const cols = Math.max(1, ...rows.map((r) => r.length));
    for (const r of rows) while (r.length < cols) r.push({ text: "" });
    return { kind: "table", rows, ...(header.length ? { headerRow: true } : {}), name: attr(tbl, "name") ?? undefined };
  };

  const listBlocks = (el: Element, depth: number, inherited: string | null, counters: number[], goesOn = false): Block[] => {
    const styleName = attr(el, "style-name") ?? inherited;
    const lv = styleName ? looks.get(`list:${styleName}`)?.listLevels?.[Math.min(depth, 9)] : undefined;
    const numbered = !!lv?.num;
    const out: Block[] = [];
    // (a list that goes on from an earlier one — Word writes each numbered heading as a list of its own — keeps counting)
    const cont = goesOn || attr(el, "continue-numbering") === "true" || !!attr(el, "continue-list");
    for (const item of children(el)) {
      if (item.localName !== "list-item" && item.localName !== "list-header") continue;
      const start = Number(attr(item, "start-value"));
      if (Number.isFinite(start) && start > 0) counters[depth] = start - 1;
      // (an item holding only a sub-list has no number of its own)
      const own = children(item).some((c) => c.localName === "p" || c.localName === "h");
      if (item.localName === "list-item" && own) {
        counters[depth] = (counters[depth] ?? 0) + 1;
        counters.length = depth + 1;
      }
      let first = item.localName === "list-item";
      for (const c of children(item)) {
        if (c.localName === "p" || c.localName === "h") {
          const nums = Array.from({ length: Math.min(lv?.display ?? 1, depth + 1) }, (_, k) => counters[depth + 1 - Math.min(lv?.display ?? 1, depth + 1) + k] || 1);
          const label = lv ? `${lv.prefix}${nums.join(".")}${lv.suffix} ` : "";
          out.push(...paraBlocks(c, { depth, numbered, label, first }));
          first = false;
        } else if (c.localName === "list") out.push(...listBlocks(c, depth + 1, styleName, counters, cont));
        else if (c.localName === "table") out.push(tableBlock(c));
      }
    }
    return out;
  };

  const countersOf = new Map<string, number[]>();
  const bodyBlocks = (el: Element) => {
    for (const c of children(el)) {
      switch (c.localName) {
        case "p":
        case "h":
          blocks.push(...paraBlocks(c));
          break;
        case "list":
          {
            // one count per list style: a list that goes on from an earlier one (continue-numbering / continue-list)
            // counts on from it
            const st = attr(c, "style-name") ?? "";
            const counters = countersOf.get(st) ?? [];
            countersOf.set(st, counters);
            blocks.push(...listBlocks(c, 0, null, counters));
          }
          break;
        case "table":
          blocks.push(tableBlock(c));
          break;
        case "section":
        case "index-body":
        case "table-of-content":
        case "alphabetical-index":
        case "illustration-index":
        case "bibliography":
          bodyBlocks(c);
          break;
        case "frame": {
          const b = imageBlock(c);
          if (b) blocks.push(b);
          break;
        }
        default:
          break;
      }
    }
  };
  const text = descendants(doc, "text").find((e) => e.parentNode && (e.parentNode as Element).localName === "body");
  if (!text) throw new Error(t("engine.odt.notOdt"));
  bodyBlocks(text);
  if (!blocks.length) blocks.push({ kind: "para", para: paraRuns([{ text: "", fontSize: 12 * PT }]) });
  const pages = flowBlocks(blocks, baseName(name), assets, { source: { format: "odt", name }, ...(width && height ? { width, height } : {}), ...(margins ? { margins } : {}) });
  return { pages, assets, paragraphs, tables, pictures };
}
