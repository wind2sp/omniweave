// Markdown (CommonMark subset): headings, lists, quotes, fenced code, rules, pipe tables,
// **bold**, *italic*, `code`. Paragraph roles keep the structure for export back to Markdown.
// Links and images are kept as literal Markdown text so nothing is lost on a round trip.

import { tableGrid } from "../../core/table";
import { MONO_FONT, newPage, newText, type Page, type ParaRole, type SceneNode, type SourceFragment, type TableNode, type TextParagraph, type TextRun } from "../../core/types";
import { MONO_RUN, flowBlocks, pagesFor, paraRuns, readingOrder, type Block } from "./flow";
import { baseName } from "./text";
import { decodeText } from "./textcodec";
import { acceptedPages } from "../../core/review";
import type { AssetRef } from "../../core/types";
import { NoteCollector, docHeaderFooter, imageDataUrl } from "./docExtras";

export const HEADING_SIZE: Record<string, number> = { h1: 32, h2: 26, h3: 22, h4: 19, h5: 17, h6: 16 };
const BODY = 15;

/** Inline Markdown → runs. */
export function inlineRuns(s: string, base: Partial<TextRun> = {}): Partial<TextRun>[] {
  const runs: Partial<TextRun>[] = [];
  let bold = false, italic = false;
  let buf = "";
  const flush = () => {
    if (buf) runs.push({ fontSize: BODY, ...base, text: buf, bold: bold || !!base.bold, italic: italic || !!base.italic });
    buf = "";
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    // escapable punctuation (incl. > = ~ that the exporter escapes at the start of a line after a hard break)
    if (c === "\\" && i + 1 < s.length && /[\\`*_[\]#+\-.!|>=~]/.test(s[i + 1])) {
      buf += s[++i];
      continue;
    }
    if (c === "`") {
      const j = s.indexOf("`", i + 1);
      if (j > i) {
        flush();
        runs.push({ ...base, ...MONO_RUN, fontSize: (base.fontSize ?? BODY) * 0.92, text: s.slice(i + 1, j) });
        i = j;
        continue;
      }
    }
    if ((c === "*" || c === "_") && s[i + 1] === c) {
      // ** or __ toggles bold (only when a closing marker exists, or when closing)
      if (bold || s.indexOf(c + c, i + 2) > i + 2) {
        flush();
        bold = !bold;
        i++;
        continue;
      }
    } else if (c === "*" || (c === "_" && (i === 0 || /\W/.test(s[i - 1]) || italic))) {
      if (italic || (s.indexOf(c, i + 1) > i + 1 && s[i + 1] !== " ")) {
        flush();
        italic = !italic;
        continue;
      }
    }
    buf += c;
  }
  flush();
  return runs;
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (s[i] === "|") {
      cells.push(cur.trim());
      cur = "";
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Source line range [from, to] (inclusive) of a block; blocks of one fenced code block share one span object. */
export type Span = { from: number; to: number };

export function markdownBlocks(md: string, spans?: Map<Block, Span>): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let paraStart = 0;
  let span: Span = { from: 0, to: 0 };
  const at = (from: number, to = from) => (span = { from, to });
  const push = (b: Block) => {
    blocks.push(b);
    spans?.set(b, span);
  };
  const mk = (runs: Partial<TextRun>[], role?: ParaRole, extra: Partial<TextParagraph> = {}) => push({ kind: "para", para: paraRuns(runs, { ...(role ? { role } : {}), ...extra }) });
  const flushPara = () => {
    if (!para.length) return;
    at(paraStart, paraStart + para.length - 1);
    // CommonMark hard line break: a line ending in an unescaped "\" or in two or more spaces → "\n"
    // (a line break inside the paragraph, as the exporter writes it); other line ends are soft (a space)
    const text = para
      .map((l, k) => {
        if (k === para.length - 1) return l.trim();
        const t = l.trim();
        if (/(?:^|[^\\])(?:\\\\)*\\$/.test(t)) return t.slice(0, -1) + "\n";
        return t + (/ {2,}$/.test(l) ? "\n" : " ");
      })
      .join("");
    mk(inlineRuns(text), undefined, { lineSpacing: 1.6, spaceAfter: 10 });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flushPara();
      const close = fence[1];
      let j = i + 1;
      const code: string[] = [];
      while (j < lines.length && !lines[j].trim().startsWith(close)) code.push(lines[j++]);
      at(i, Math.min(j, lines.length - 1));
      code.forEach((c, k) =>
        mk([{ ...MONO_RUN, text: c, color: "#24292f" }], "code", { lineSpacing: 1.35, spaceAfter: k === code.length - 1 ? 10 : 0 }),
      );
      if (!code.length) mk([{ ...MONO_RUN, text: "" }], "code", { spaceAfter: 10 });
      i = j;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      at(i);
      const role = ("h" + h[1].length) as ParaRole;
      mk(inlineRuns(h[2], { fontSize: HEADING_SIZE[role], bold: true }), role, { lineSpacing: 1.3, spaceAfter: 10 });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara();
      at(i);
      mk([{ text: "", fontSize: BODY }], "hr", { spaceAfter: 12 });
      continue;
    }
    // pipe table: header row + separator row
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flushPara();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "CENTER" : c.endsWith(":") ? "RIGHT" : undefined));
      const rows = [head];
      let j = i + 2;
      while (j < lines.length && lines[j].includes("|") && lines[j].trim()) rows.push(splitRow(lines[j++]));
      at(i, j - 1);
      push({
        kind: "table",
        rows: rows.map((r) => head.map((_, c) => ({ text: r[c] ?? "", ...(aligns[c] ? { align: aligns[c] as "CENTER" | "RIGHT" } : {}) }))),
        headerRow: true,
      });
      i = j - 1;
      continue;
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      at(i);
      mk(inlineRuns(q[1], { italic: true, color: "#57606a" }), "quote", { indent: 18, spaceAfter: 6 });
      continue;
    }
    const li = /^(\s*)([-*+])\s+(.*)$/.exec(line);
    if (li) {
      flushPara();
      at(i);
      const depth = Math.floor(li[1].replace(/\t/g, "    ").length / 2);
      mk(inlineRuns("• " + li[3]), "li", { indent: 14 + depth * 22, spaceAfter: 3 });
      continue;
    }
    const oli = /^(\s*)(\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (oli) {
      flushPara();
      at(i);
      const depth = Math.floor(oli[1].replace(/\t/g, "    ").length / 2);
      mk(inlineRuns(oli[2] + " " + oli[3]), "oli", { indent: 14 + depth * 22, spaceAfter: 3 });
      continue;
    }
    if (!para.length) paraStart = i;
    para.push(line);
  }
  flushPara();
  return blocks;
}

export function importMarkdown(bytes: Uint8Array, name: string): Page[] {
  const d = decodeText(bytes);
  const spans = new Map<Block, Span>();
  const blocks = markdownBlocks(d.text, spans);
  const pages = flowBlocks(blocks, baseName(name), {}, { source: { format: "md", name, encoding: d.encoding, eol: d.eol, bom: d.bom } });
  attachFragments(d.text, blocks, spans, pages);
  return pages;
}

// ───────── source fragments: unchanged blocks are written back as they were in the file ─────────

/** Canonical Markdown of some paragraphs or one table on their own (no trailing newline). */
function unitMarkdown(nodes: TextParagraph[] | TableNode): string {
  const page = newPage("DOCUMENT", 794, 1123);
  if (Array.isArray(nodes)) {
    const t = newText("", 600);
    t.paragraphs = nodes;
    page.nodes.push(t);
  } else page.nodes.push(nodes);
  return pagesToMarkdown([page]).replace(/\n+$/, "");
}

function attachFragments(md: string, blocks: Block[], spans: Map<Block, Span>, pages: Page[]) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  // groups of blocks sharing one source span (a fenced code block = several paragraphs)
  const groups: { span: Span; blocks: Block[] }[] = [];
  for (const b of blocks) {
    const sp = spans.get(b);
    if (!sp) continue;
    const last = groups[groups.length - 1];
    if (last && last.span === sp) last.blocks.push(b);
    else groups.push({ span: sp, blocks: [b] });
  }
  // where each paragraph / table chunk ended up
  const pageOfPara = new Map<string, Page>();
  const tableChunks: { node: TableNode; page: Page }[] = [];
  for (const pg of pages)
    for (const n of pg.nodes) {
      if (n.type === "TEXT" && !n.notes) for (const p of n.paragraphs) pageOfPara.set(p.id, pg);
      else if (n.type === "TABLE") tableChunks.push({ node: n, page: pg });
    }
  groups.forEach((g, k) => {
    const next = groups[k + 1]?.span.from ?? lines.length;
    const from = k === 0 ? 0 : g.span.from; // leading blank lines belong to the first block
    const raw = lines.slice(from, g.span.to + 1).join("\n");
    const gap = lines.slice(g.span.to + 1, next);
    const sep = "\n" + gap.join("\n") + (gap.length && k + 1 < groups.length ? "\n" : "");
    let ids: string[], canon: string, page: Page | undefined;
    const b0 = g.blocks[0];
    if (b0.kind === "table") {
      const cells = new Set(b0.rows.flat());
      const chunks = tableChunks.filter((c) => c.node.rows.some((r) => r.some((x) => cells.has(x))));
      if (chunks.length !== 1) return; // split across pages: written canonically
      ids = [chunks[0].node.id];
      canon = unitMarkdown(chunks[0].node);
      page = chunks[0].page;
    } else {
      const ps = g.blocks.flatMap((b) => (b.kind === "para" ? [b.para] : []));
      if (!ps.length) return;
      ids = ps.map((p) => p.id);
      canon = unitMarkdown(ps);
      page = pageOfPara.get(ids[0]);
    }
    if (!page?.source) return;
    (page.source.fragments ??= []).push({ ids, raw, canon, sep, n: k });
  });
}

const LISTISH = /^\s*([-*+]|\d{1,9}[.)])\s/;

/**
 * Markdown for pages that came from a Markdown file: blocks whose content is unchanged are written
 * from their original source text (spacing, soft line breaks, *emphasis* style, escapes kept);
 * edited or new blocks are written canonically.
 */
function markdownWithFragments(pages: Page[]): string {
  const byFirst = new Map<string, SourceFragment>();
  for (const p of pages) for (const f of p.source?.fragments ?? []) byFirst.set(f.ids[0], f);
  type Unit = { text: string; frag: SourceFragment | null };
  const units: Unit[] = [];
  let loose: TextParagraph[] = [];
  const flushLoose = () => {
    if (loose.length) units.push({ text: unitMarkdown(loose), frag: null });
    loose = [];
  };
  const emit = (canon: string, f: SourceFragment) => {
    flushLoose();
    units.push(canon === f.canon ? { text: f.raw, frag: f } : { text: canon, frag: null });
  };
  for (const n of readingOrder(pages) as SceneNode[]) {
    if (n.type === "TABLE") {
      const f = byFirst.get(n.id);
      if (f) emit(unitMarkdown(n), f);
      else {
        flushLoose();
        units.push({ text: unitMarkdown(n), frag: null });
      }
      continue;
    }
    if (n.type !== "TEXT") continue;
    const ps = n.paragraphs;
    for (let i = 0; i < ps.length; i++) {
      const f = byFirst.get(ps[i].id);
      if (f && f.ids.every((id, k) => ps[i + k]?.id === id)) {
        emit(unitMarkdown(ps.slice(i, i + f.ids.length)), f);
        i += f.ids.length - 1;
      } else loose.push(ps[i]);
    }
  }
  flushLoose();
  let out = "";
  units.forEach((u, i) => {
    if (!u.text && !u.frag) return;
    if (i > 0) {
      const prev = units[i - 1];
      if (prev.frag && u.frag && u.frag.n === prev.frag.n + 1) out += prev.frag.sep;
      else {
        const lastLine = prev.text.split("\n").pop() ?? "";
        const firstLine = u.text.split("\n")[0] ?? "";
        out += LISTISH.test(lastLine) && LISTISH.test(firstLine) ? "\n" : "\n\n";
      }
    }
    out += u.text;
  });
  const last = units[units.length - 1];
  return out + (last?.frag ? last.frag.sep || "" : "\n");
}

// ───────── export ─────────

function escInline(s: string) {
  return s.replace(/([\\`*_])/g, "\\$1");
}

export function runsToMarkdown(runs: TextRun[], skipBold = false): string {
  let out = "";
  for (const r of runs) {
    if (!r.text) continue;
    if (r.fontFamily === MONO_FONT) {
      out += "`" + r.text.replace(/\n/g, " ") + "`";
      continue;
    }
    const lead = /^\s*/.exec(r.text)![0], trail = /\s*$/.exec(r.text)![0];
    const core = r.text.trim();
    if (!core) {
      out += r.text;
      continue;
    }
    let t = escInline(core);
    if (r.italic) t = `*${t}*`;
    if (r.bold && !skipBold) t = `**${t}**`;
    out += lead + t + trail;
  }
  return hardBreaks(out.replace(/\*\*\*\*/g, ""));
}

/**
 * "\n" inside a paragraph (a line break, e.g. Word w:br) → a CommonMark hard line break ("\" at the
 * end of the line). The next line is escaped so it can never open a block of its own (ATX heading,
 * list item, quote, fence, thematic break or setext underline) and change the document structure.
 */
function hardBreaks(s: string): string {
  if (!s.includes("\n")) return s;
  return s
    .replace(/\n+$/, "")
    .split("\n")
    .map((line, i) => (i ? line.trimStart().replace(/^(#|>|[-+=]|```|~~~|\d+(?=[.)]))/, (m) => (/^\d/.test(m) ? m + "\\" : "\\" + m)) : line))
    .join("\\\n");
}

function headingLevel(p: TextParagraph): number {
  if (p.role && /^h[1-6]$/.test(p.role)) return Number(p.role[1]);
  const runs = p.runs.filter((r) => r.text.trim());
  if (!runs.length || !runs.every((r) => r.bold)) return 0;
  const size = Math.max(...runs.map((r) => r.fontSize));
  if (size >= 30) return 1;
  if (size >= 24) return 2;
  if (size >= 20) return 3;
  return 0;
}

export function pagesToMarkdown(pages: Page[], assets?: Record<string, AssetRef>): string {
  pages = acceptedPages(pages); // tracked changes as accepted (core/review.ts)
  const out: string[] = [];
  // footnotes / endnotes as [^n] with their text at the end, pictures as data: images, headers / footers as text
  // (QA ui-audit #34: they were left out)
  const notes = new NoteCollector();
  const hf = docHeaderFooter(pages);
  if (hf.header.length) out.push(...hf.header.map((h) => h.replace(/\n/g, "  \n")), "", "---", "");
  let inCode = false;
  let prevList = false;
  const endCode = () => {
    if (inCode) out.push("```", "");
    inCode = false;
  };
  for (const n of readingOrder(pages)) {
    if (n.type === "TABLE") {
      endCode();
      const g = tableGrid(n).map((r) => r.map((c) => c.replace(/\|/g, "\\|").replace(/\n/g, " ")));
      if (!g.length) continue;
      out.push("| " + g[0].join(" | ") + " |");
      out.push("| " + g[0].map((_, c) => (n.rows[1]?.[c]?.align === "CENTER" ? ":---:" : n.rows[1]?.[c]?.align === "RIGHT" ? "---:" : "---")).join(" | ") + " |");
      for (const r of g.slice(1)) out.push("| " + r.join(" | ") + " |");
      out.push("");
      continue;
    }
    if (n.type === "IMAGE") {
      const src = imageDataUrl(n, assets);
      if (src) {
        endCode();
        out.push(`![${(n.name ?? "").replace(/[\[\]]/g, "")}](${src})`, "");
        prevList = false;
      }
      continue;
    }
    if (n.type !== "TEXT") continue;
    for (const p0 of n.paragraphs) {
      // a note reference → a mark replaced by [^n] once the line is written (not escaped as text); inline object chars go
      const p = p0.runs.some((r) => r.note || r.obj) ? { ...p0, runs: p0.runs.filter((r) => !r.obj).map((r) => (r.note ? { ...r, note: undefined, text: `\u0001${notes.add(r)!.id}\u0001` } : r)) } : p0;
      const text = p.runs.map((r) => r.text).join("");
      const isCode = p.role === "code" || (p.runs.length > 0 && p.runs.every((r) => r.fontFamily === MONO_FONT) && p.role !== "li");
      if (isCode) {
        if (!inCode) {
          if (prevList) out.push("");
          out.push("```");
          inCode = true;
        }
        out.push(text);
        prevList = false;
        continue;
      }
      endCode();
      const lv = headingLevel(p);
      if (p.role === "hr") out.push("---", "");
      else if (lv) out.push("#".repeat(lv) + " " + runsToMarkdown(p.runs.map((r) => ({ ...r, text: r.text.replace(/\n/g, " ") })), true), ""); // an ATX heading is one line
      else if (p.role === "li" || /^•\s/.test(text)) {
        const depth = Math.max(0, Math.round((p.indent - 14) / 22));
        const runs = p.runs.map((r, i) => (i === 0 ? { ...r, text: r.text.replace(/^•\s?/, "") } : r));
        out.push("  ".repeat(depth) + "- " + runsToMarkdown(runs));
        prevList = true;
        continue;
      } else if (p.role === "oli") {
        const depth = Math.max(0, Math.round((p.indent - 14) / 22));
        out.push("   ".repeat(depth) + runsToMarkdown(p.runs).replace(/^(\d+)\\?([.)])/, "$1$2"));
        prevList = true;
        continue;
      } else if (p.role === "quote") out.push("> " + runsToMarkdown(p.runs.map((r) => ({ ...r, italic: false }))), "");
      else if (!text.trim()) {
        if (prevList) out.push("");
      } else {
        if (prevList) out.push("");
        out.push(runsToMarkdown(p.runs), "");
      }
      prevList = false;
    }
  }
  endCode();
  if (hf.footer.length) out.push("", "---", "", ...hf.footer.map((h) => h.replace(/\n/g, "  \n")));
  if (notes.any) out.push("", ...notes.notes.map((x) => `[^${x.id}]: ${x.text.replace(/\n/g, "\n    ")}`));
  return out.join("\n").replace(/\u0001(\w+)\u0001/g, "[^$1]").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function exportMarkdown(pages: Page[], assets?: Record<string, AssetRef>): string {
  const own = pagesFor(pages, ["md"]);
  return own.some((p) => p.source?.fragments?.length) ? markdownWithFragments(own) : pagesToMarkdown(own, assets);
}
