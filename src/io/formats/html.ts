// HTML / XHTML → document blocks (headings, paragraphs, lists, quotes, pre, tables, images),
// and document pages → simple semantic HTML. Scripts and styles are never executed or kept.

import { tableGrid } from "../../core/table";
import { MONO_FONT, type Page, type ParaRole, type TableCell, type TextParagraph, type TextRun } from "../../core/types";
import { esc } from "../xml";
import { MONO_RUN, flowBlocks, pagesFor, paraRuns, readingOrder, type Block } from "./flow";
import { HEADING_SIZE } from "./markdown";
import { baseName } from "./text";
import { decodeText } from "./textcodec";
import { acceptedPages } from "../../core/review";
import type { AssetRef } from "../../core/types";
import { NoteCollector, docHeaderFooter, imageDataUrl, imageSize } from "./docExtras";

const BODY = 15;
const SKIP = new Set(["script", "style", "head", "noscript", "template", "svg", "math", "iframe", "object", "button", "select", "input", "textarea", "title", "meta", "link"]);
const BLOCK = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption", "address", "dl", "dt", "dd", "body", "html", "center", "form", "fieldset", "details", "summary", "caption"]);

const tag = (n: Node) => ((n as Element).localName || n.nodeName || "").toLowerCase();

export type ImageResolver = (src: string, alt: string) => { assetId: string; width: number; height: number; name: string } | null;

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  mono: boolean;
  color?: string;
  size?: number;
}

export function htmlBlocks(root: Node, resolveImage: ImageResolver = () => null): Block[] {
  const blocks: Block[] = [];
  let runs: Partial<TextRun>[] = [];
  let role: ParaRole | undefined;
  let extra: Partial<TextParagraph> = {};
  const listStack: { ordered: boolean; n: number }[] = [];
  let quote = 0;

  const flush = () => {
    // collapse whitespace across run boundaries
    const text = runs.map((r) => r.text).join("");
    if (!role && quote) {
      role = "quote";
      extra = { ...extra, indent: 18 };
    }
    if (text.trim() || role === "code") {
      const out: Partial<TextRun>[] = [];
      let prevSpace = true;
      for (const r of runs) {
        let t = r.text ?? "";
        if (role !== "code") {
          t = t.replace(/\s+/g, " ");
          if (prevSpace) t = t.replace(/^ /, "");
          if (t) prevSpace = t.endsWith(" ");
        }
        if (t) out.push({ ...r, text: t });
      }
      if (out.length && role !== "code") out[out.length - 1].text = out[out.length - 1].text!.replace(/ $/, "");
      if (out.length) blocks.push({ kind: "para", para: paraRuns(out, { ...(role ? { role } : {}), lineSpacing: 1.6, spaceAfter: 8, ...extra }) });
    }
    runs = [];
    role = undefined;
    extra = {};
  };

  const pushText = (t: string, st: Style) => {
    if (!t) return;
    runs.push({
      text: t,
      bold: st.bold,
      italic: st.italic,
      underline: st.underline,
      fontSize: st.mono ? (st.size ?? BODY) * 0.92 : st.size ?? BODY,
      ...(st.mono ? { fontFamily: MONO_FONT } : {}),
      ...(st.color ? { color: st.color } : {}),
    });
  };

  const walk = (n: Node, st: Style, pre: boolean) => {
    if (n.nodeType === 3 || n.nodeType === 4) {
      pushText(n.nodeValue ?? "", st);
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    const t = tag(n);
    if (SKIP.has(t)) return;
    const el = n as Element;
    const kids = () => {
      for (let c = n.firstChild; c; c = c.nextSibling) walk(c, st2, pre);
    };
    let st2 = st;
    const hm = /^h([1-6])$/.exec(t);
    if (hm) {
      flush();
      role = t as ParaRole;
      extra = { lineSpacing: 1.3, spaceAfter: 10 };
      st2 = { ...st, bold: true, size: HEADING_SIZE[t] };
      kids();
      role = t as ParaRole;
      flush();
      return;
    }
    switch (t) {
      case "br":
        if (pre) pushText("\n", st);
        else {
          const r = role, e = extra;
          flush();
          role = r;
          extra = e;
        }
        return;
      case "hr":
        flush();
        blocks.push({ kind: "para", para: paraRuns([{ text: "" }], { role: "hr", spaceAfter: 12 }) });
        return;
      case "img": {
        const src = el.getAttribute("src") ?? "";
        const alt = el.getAttribute("alt") ?? "";
        const img = src ? resolveImage(src, alt) : null;
        if (img) {
          flush();
          blocks.push({ kind: "image", ...img });
        } else if (alt) pushText(`[${alt}]`, { ...st, italic: true });
        return;
      }
      case "b":
      case "strong":
        st2 = { ...st, bold: true };
        break;
      case "i":
      case "em":
      case "cite":
      case "var":
        st2 = { ...st, italic: true };
        break;
      case "u":
      case "ins":
        st2 = { ...st, underline: true };
        break;
      case "a":
        st2 = el.getAttribute("href") ? { ...st, underline: true, color: "#2f5bd3" } : st;
        break;
      case "code":
      case "kbd":
      case "samp":
      case "tt":
        st2 = { ...st, mono: true };
        break;
      case "pre": {
        flush();
        const text = el.textContent ?? "";
        const lines = text.replace(/^\n/, "").replace(/\n$/, "").split("\n");
        lines.forEach((l, i) => blocks.push({ kind: "para", para: paraRuns([{ ...MONO_RUN, text: l }], { role: "code", lineSpacing: 1.35, spaceAfter: i === lines.length - 1 ? 10 : 0 }) }));
        return;
      }
      case "blockquote":
        flush();
        quote++;
        st2 = { ...st, italic: true, color: "#57606a" };
        kids();
        flush();
        quote--;
        return;
      case "ul":
      case "ol":
        flush();
        listStack.push({ ordered: t === "ol", n: Number(el.getAttribute("start") ?? 1) || 1 });
        kids();
        flush();
        listStack.pop();
        return;
      case "li": {
        flush();
        const l = listStack[listStack.length - 1] ?? { ordered: false, n: 1 };
        const depth = Math.max(0, listStack.length - 1);
        pushText(l.ordered ? `${l.n++}. ` : "• ", st);
        for (let c = n.firstChild; c; c = c.nextSibling) {
          const ct = tag(c);
          if (ct === "ul" || ct === "ol") {
            role = l.ordered ? "oli" : "li";
            extra = { indent: 14 + depth * 22, spaceAfter: 3 };
            walk(c, st, pre);
          } else walk(c, st, pre);
        }
        role = l.ordered ? "oli" : "li";
        extra = { indent: 14 + depth * 22, spaceAfter: 3 };
        flush();
        return;
      }
      case "table": {
        flush();
        const rows: TableCell[][] = [];
        let header = false;
        const visitRows = (p: Node) => {
          for (let c = p.firstChild; c; c = c.nextSibling) {
            const ct = tag(c);
            if (ct === "thead" || ct === "tbody" || ct === "tfoot") visitRows(c);
            else if (ct === "tr") {
              const row: TableCell[] = [];
              for (let d = c.firstChild; d; d = d.nextSibling) {
                const dt = tag(d);
                if (dt !== "td" && dt !== "th") continue;
                if (dt === "th" && !rows.length) header = true;
                const text = (d.textContent ?? "").replace(/\s+/g, " ").trim();
                row.push({ text, ...(dt === "th" ? { bold: true } : {}) });
                const span = Number((d as Element).getAttribute("colspan") ?? 1);
                for (let k = 1; k < span && k < 50; k++) row.push({ text: "" });
              }
              if (row.length) rows.push(row);
            }
          }
        };
        visitRows(n);
        if (rows.length) blocks.push({ kind: "table", rows, headerRow: header });
        return;
      }
    }
    if (BLOCK.has(t) || t === "td" || t === "th" || t === "tr") {
      flush();
      kids();
      flush();
      return;
    }
    kids();
  };
  walk(root, { bold: false, italic: false, underline: false, mono: false }, false);
  flush();
  return blocks;
}

export function parseHtml(text: string): Document {
  const P: any = (globalThis as any).DOMParser;
  if (!P) throw new Error("DOMParser unavailable");
  return new P().parseFromString(text, "text/html");
}

export function htmlTitle(doc: Document): string | null {
  const t = doc.getElementsByTagName("title")[0];
  return t?.textContent?.trim() || null;
}

export function importHtml(bytes: Uint8Array, name: string): Page[] {
  const d = decodeText(bytes);
  const doc = parseHtml(d.text);
  const body = doc.getElementsByTagName("body")[0] ?? doc.documentElement ?? doc;
  // the head (styles, scripts, meta, links) is not shown but is written back as it was
  const head = /^[\s\S]*?<\/head\s*>/i.exec(d.text)?.[0];
  const bodyTag = head ? /<body\b[^>]*>/i.exec(d.text.slice(head.length))?.[0] : undefined;
  const keep = head ? { htmlHead: head.replace(/\r\n?/g, "\n"), ...(bodyTag ? { htmlBodyTag: bodyTag } : {}) } : {};
  return flowBlocks(htmlBlocks(body), baseName(name), {}, { source: { format: "html", name, encoding: d.encoding, eol: d.eol, bom: d.bom, ...keep } });
}

// ───────── export ─────────

function runHtmlOf(r: TextRun): string {
  // a line break inside the paragraph (Word w:br, HWPX hp:lineBreak) — whitespace in HTML, so a <br>
  let t = esc(r.text).replace(/\n/g, "<br>");
  if (r.fontFamily === MONO_FONT) t = `<code>${t}</code>`;
  if (r.underline) t = `<u>${t}</u>`;
  if (r.italic) t = `<em>${t}</em>`;
  if (r.bold) t = `<strong>${t}</strong>`;
  if (r.color && !/^#(1d1f24|000000)$/i.test(r.color)) t = `<span style="color:${esc(r.color)}">${t}</span>`;
  return t;
}

export function pagesToHtml(pages: Page[], title: string, assets?: Record<string, AssetRef>): string {
  pages = acceptedPages(pages); // tracked changes as accepted (core/review.ts)
  const body: string[] = [];
  // footnotes / endnotes: a numbered link at the reference, their text at the end (QA ui-audit #34)
  const notes = new NoteCollector();
  const runHtml = (r: TextRun): string => {
    if (r.obj) return "";
    const n = notes.add(r);
    return n ? `<sup><a href="#fn${n.id}" id="fnref${n.id}">${esc(n.mark)}</a></sup>` : runHtmlOf(r);
  };
  const hf = docHeaderFooter(pages);
  if (hf.header.length) body.push(`<header>${hf.header.map((h) => `<p>${esc(h).replace(/\n/g, "<br>")}</p>`).join("")}</header>`);
  let list: "ul" | "ol" | null = null;
  let code = false;
  const close = () => {
    if (list) body.push(`</${list}>`);
    list = null;
    if (code) body[body.length - 1] += "</code></pre>";
    code = false;
  };
  for (const n of readingOrder(pages)) {
    if (n.type === "TABLE") {
      close();
      const g = tableGrid(n);
      body.push("<table>");
      g.forEach((r, i) => body.push("<tr>" + r.map((c) => (i === 0 && n.headerRow ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join("") + "</tr>"));
      body.push("</table>");
      continue;
    }
    if (n.type === "IMAGE") {
      // a picture: its bytes in the file (one file, as the export is), at its shown size
      const src = imageDataUrl(n, assets);
      if (src) {
        close();
        const z = imageSize(n);
        body.push(`<p><img src="${src}" alt="${esc(n.name ?? "")}" width="${z.w}" height="${z.h}"></p>`);
      }
      continue;
    }
    if (n.type !== "TEXT") continue;
    for (const p of n.paragraphs) {
      const role = p.role;
      if (role === "code") {
        const line = esc(p.runs.map((r) => r.text).join(""));
        if (!code) {
          close();
          body.push("<pre><code>" + line);
          code = true;
        } else body[body.length - 1] += "\n" + line;
        continue;
      }
      if (role === "li" || role === "oli") {
        const want = role === "li" ? "ul" : "ol";
        if (list !== want) {
          close();
          body.push(`<${want}>`);
          list = want;
        }
        const runs = p.runs.map((r, i) => (i === 0 ? { ...r, text: r.text.replace(role === "li" ? /^•\s?/ : /^\d+[.)]\s?/, "") } : r));
        body.push(`<li>${runs.map(runHtml).join("")}</li>`);
        continue;
      }
      close();
      const inner = p.runs.map((r) => (role && /^h\d$/.test(role) ? runHtml({ ...r, bold: false }) : runHtml(r))).join("");
      if (role === "hr") body.push("<hr>");
      else if (role && /^h\d$/.test(role)) body.push(`<${role}>${inner}</${role}>`);
      else if (role === "quote") body.push(`<blockquote>${p.runs.map((r) => runHtml({ ...r, italic: false })).join("")}</blockquote>`);
      else {
        const al = p.align === "CENTER" ? ' style="text-align:center"' : p.align === "RIGHT" ? ' style="text-align:right"' : "";
        body.push(`<p${al}>${inner}</p>`);
      }
    }
  }
  close();
  if (notes.any) body.push(`<section class="footnotes"><hr><ol>${notes.notes.map((x) => `<li id="fn${x.id}" value="${/^\d+$/.test(x.mark) ? x.mark : x.id}">${esc(x.text).replace(/\n/g, "<br>")} <a href="#fnref${x.id}">↩</a></li>`).join("")}</ol></section>`);
  if (hf.footer.length) body.push(`<footer>${hf.footer.map((h) => `<p>${esc(h).replace(/\n/g, "<br>")}</p>`).join("")}</footer>`);
  const src = pages.find((p) => p.source?.htmlHead)?.source;
  if (src?.htmlHead) return `${src.htmlHead}\n${src.htmlBodyTag ?? "<body>"}\n${body.join("\n")}\n</body>\n</html>\n`;
  return `<!DOCTYPE html>\n<html lang="ko">\n<head>\n<meta charset="utf-8">\n<title>${esc(title)}</title>\n</head>\n<body>\n${body.join("\n")}\n</body>\n</html>\n`;
}

export function exportHtml(pages: Page[], title: string, assets?: Record<string, AssetRef>): string {
  return pagesToHtml(pagesFor(pages, ["html", "epub", "md"]), title, assets);
}
