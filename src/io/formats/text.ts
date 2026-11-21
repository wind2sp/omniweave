// Plain and code text: TXT, LOG, BAT/CMD, JSON, XML, YAML, and "open as source" for HTML/Markdown/SRT.
// Each line becomes one paragraph, so saving writes back exactly the lines that were opened
// (encoding, line endings and BOM are restored from page.source).

import { t as tr } from "../../i18n";
import { plainText } from "../../core/text";
import { tableGrid } from "../../core/table";
import type { Page, PageSource } from "../../core/types";
import { codeBlocks, flowBlocks, pagesFor, readingOrder, sourceOf } from "./flow";
import { decodeText, encodeText } from "./textcodec";
import { acceptedPages } from "../../core/review";

export function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}

/** Import text as document pages. `mono` = code view (monospace, tight lines). */
export function importTextPages(bytes: Uint8Array, name: string, format: string, mono: boolean, transform?: (t: string) => string): { pages: Page[]; text: string; source: PageSource } {
  const d = decodeText(bytes);
  const text = transform ? transform(d.text) : d.text;
  const source: PageSource = { format, name, encoding: d.encoding, eol: d.eol, bom: d.bom };
  const pages = flowBlocks(codeBlocks(text, mono), baseName(name), {}, { source, wordBreak: "keep-all" });
  return { pages, text, source };
}

/** Lines of every text node (and tab-separated table rows) in reading order. */
export function pagesToText(pages: Page[]): string {
  pages = acceptedPages(pages); // tracked changes as accepted (core/review.ts)
  const parts: string[] = [];
  for (const n of readingOrder(pages)) {
    if (n.type === "TEXT") parts.push(plainText(n));
    else if (n.type === "TABLE") parts.push(tableGrid(n).map((r) => r.join("\t")).join("\n"));
  }
  return parts.join("\n");
}

export function exportTextPages(allPages: Page[], formats: string[]): Uint8Array {
  const pages = pagesFor(allPages, formats);
  const src = sourceOf(allPages, formats);
  return encodeText(pagesToText(pages), { encoding: src?.encoding, bom: src?.bom, eol: src?.eol });
}

// ───────── validation ─────────

export interface Problem {
  line: number; // 1-based
  col: number;
  message: string;
}

function lineCol(text: string, pos: number): { line: number; col: number } {
  const before = text.slice(0, pos);
  const line = before.split("\n").length;
  return { line, col: pos - before.lastIndexOf("\n") };
}

export function checkJson(text: string): Problem | null {
  try {
    JSON.parse(text);
    return null;
  } catch (e: any) {
    // engines differ in whether they report a position, so locate the error ourselves
    const pos = jsonErrorAt(text);
    return { ...lineCol(text, pos), message: String(e?.message ?? e).replace(/\s+/g, " ").slice(0, 160) };
  }
}

/** Offset of the first JSON syntax error (small recursive-descent scanner). */
function jsonErrorAt(s: string): number {
  let i = 0;
  const ws = () => {
    while (i < s.length && (s[i] === " " || s[i] === "\t" || s[i] === "\r" || s[i] === "\n")) i++;
  };
  const fail = (): never => {
    throw i;
  };
  const value = (): void => {
    ws();
    const c = s[i];
    if (c === "{") {
      i++;
      ws();
      if (s[i] === "}") return void i++;
      for (;;) {
        ws();
        if (s[i] !== '"') fail();
        str();
        ws();
        if (s[i] !== ":") fail();
        i++;
        value();
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "}") return void i++;
        fail();
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (s[i] === "]") return void i++;
      for (;;) {
        value();
        ws();
        if (s[i] === ",") {
          i++;
          continue;
        }
        if (s[i] === "]") return void i++;
        fail();
      }
    }
    if (c === '"') return str();
    const m = /^(-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?|true|false|null)/.exec(s.slice(i, i + 400));
    if (!m) fail();
    i += m![0].length;
  };
  const str = () => {
    i++;
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") i++;
      else if (s.charCodeAt(i) < 0x20) fail();
      i++;
    }
    if (s[i] !== '"') fail();
    i++;
  };
  try {
    value();
    ws();
    return i < s.length ? i : s.length;
  } catch (at) {
    return typeof at === "number" ? at : 0;
  }
}

/** Re-indent JSON without parsing values, so big numbers and key order are kept exactly. */
export function prettyJson(text: string, indent = 2): string {
  let out = "";
  let level = 0;
  const pad = () => "\n" + " ".repeat(level * indent);
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "{" || c === "[") {
      // keep empty containers on one line
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === (c === "{" ? "}" : "]")) {
        out += c + text[j];
        i = j + 1;
        continue;
      }
      level++;
      out += c + pad();
    } else if (c === "}" || c === "]") {
      level = Math.max(0, level - 1);
      out += pad() + c;
    } else if (c === ",") out += "," + pad();
    else if (c === ":") out += ": ";
    else out += c;
    i++;
  }
  return out;
}

export function checkXml(text: string): Problem | null {
  const P: any = (globalThis as any).DOMParser;
  if (!P) return null;
  let err: string | null = null;
  let doc: Document;
  try {
    // xmldom reports through an error handler; browsers return a <parsererror> document
    // xmldom (tests) reports through errorHandler — its "warnings" are well-formedness errors too;
    // browsers return a document containing <parsererror>
    const h = (m: string) => (err ??= m);
    doc = new P({ errorHandler: { warning: h, error: h, fatalError: h } }).parseFromString(text, "application/xml");
  } catch (e: any) {
    err = String(e?.message ?? e);
    doc = null as any;
  }
  if (!err && doc) {
    const pe = doc.getElementsByTagName("parsererror")[0];
    if (pe) err = pe.textContent ?? tr("engine.text.xmlError");
    else if (!doc.documentElement) err = tr("engine.text.noRoot");
  }
  if (!err) return null;
  const m = /line[^\d]*(\d+)[^\d]+(?:col(?:umn)?)?[^\d]*(\d+)/i.exec(err);
  return { line: m ? +m[1] : 1, col: m ? +m[2] : 1, message: err.replace(/\s+/g, " ").trim().slice(0, 200) };
}

/**
 * Basic YAML lint (not a full parser): tab indentation, unclosed quotes and flow brackets,
 * duplicate keys at the same level, and a mapping key indented under a scalar value.
 */
export function checkYaml(text: string): Problem | null {
  const lines = text.split("\n");
  const keys: Map<string, number>[] = [];
  let block: number | null = null; // inside a | or > block scalar: its parent indent
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^(---|\.\.\.)\s*$/.test(raw)) {
      keys.length = 0;
      continue;
    }
    const indent = raw.length - raw.replace(/^ */, "").length;
    const body = raw.slice(indent);
    if (block !== null) {
      if (!body.trim() || indent > block) continue;
      block = null;
    }
    if (body.startsWith("\t") && body.trim() && !body.trim().startsWith("#")) return { line: i + 1, col: indent + 1, message: tr("engine.text.yamlTab") };
    if (!body.trim() || body.startsWith("#")) continue;
    const content = stripComment(body);
    const q = unclosed(content);
    if (q) return { line: i + 1, col: indent + 1, message: q };
    const m = /^(?:- +)?("[^"]*"|'[^']*'|[^\s:#][^:#]*?)\s*:(\s|$)/.exec(content);
    if (m) {
      const level = indent + (content.startsWith("- ") ? 2 : 0);
      const lv = (k: Map<string, number>) => [...k.values()][0];
      // a new sequence item closes every mapping at or below its level; a dedent closes deeper ones
      const item = content.startsWith("- ");
      while (keys.length && (lv(keys[keys.length - 1]) > level || (item && lv(keys[keys.length - 1]) >= level))) keys.pop();
      let map = item ? undefined : [...keys].reverse().find((k) => lv(k) === level);
      if (!map) {
        map = new Map();
        keys.push(map);
      }
      const k = m[1].replace(/^["']|["']$/g, "");
      if (map.has(k)) return { line: i + 1, col: indent + 1, message: tr("engine.text.yamlDuplicateKey", { key: k }) };
      map.set(k, level);
      if (/:\s*[|>][-+]?\s*$/.test(content)) block = indent;
    }
  }
  return null;
}

function stripComment(s: string) {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unclosed(s: string): string | null {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === "\\" && q === '"') i++;
      else if (c === q) q = null;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s:,[{-]/.test(s[i - 1]))) q = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
  }
  if (q) return tr("engine.text.unclosedQuote", { quote: q });
  if (depth > 0) return tr("engine.text.unclosedBracket");
  if (depth < 0) return tr("engine.text.unmatchedBracket");
  return null;
}
