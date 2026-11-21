// Office Surgeon — XML element ranges.
//
// DOM parsers drop source positions, so the surgeon finds elements in the original text with this small
// scanner and copies untouched elements as the exact original characters. Elements are counted the way
// io/xml.ts `children()` counts them: element nodes only (text, comments, CDATA, processing instructions
// and the doctype are skipped), so the n-th scanned child is the n-th DOM child.

export interface XmlEl {
  /** qualified name as written ("w:p") and its local part ("p") */
  name: string;
  local: string;
  /** whole element: text.slice(start, end) */
  start: number;
  end: number;
  /** end of the start tag (just after its ">") and start of the end tag ("</"); both = end for <x/> */
  openEnd: number;
  closeStart: number;
}

const NAME = /[A-Za-z_:À-￿][\w.:\-·À-￿]*/y;

/** End (index after ">") of the tag starting at `i` ("<"), skipping quoted attribute values. */
function tagEnd(s: string, i: number): number {
  let q = "";
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (q) {
      if (c === q) q = "";
    } else if (c === '"' || c === "'") q = c;
    else if (c === ">") return j + 1;
  }
  throw new Error("unterminated tag");
}

/** Index after the markup that is not an element (comment, CDATA, PI, doctype) starting at `i`, or -1. */
function skipOther(s: string, i: number): number {
  if (s.startsWith("<!--", i)) return need(s.indexOf("-->", i + 4), 3);
  if (s.startsWith("<![CDATA[", i)) return need(s.indexOf("]]>", i + 9), 3);
  if (s.startsWith("<?", i)) return need(s.indexOf("?>", i + 2), 2);
  if (s.startsWith("<!", i)) {
    // doctype, possibly with an internal subset [...]
    let depth = 0;
    for (let j = i + 2; j < s.length; j++) {
      if (s[j] === "[") depth++;
      else if (s[j] === "]") depth--;
      else if (s[j] === ">" && depth <= 0) return j + 1;
    }
    throw new Error("unterminated doctype");
  }
  return -1;
}

const need = (at: number, len: number) => {
  if (at < 0) throw new Error("unterminated markup");
  return at + len;
};

/** The element starting at `i` (a "<" followed by a name). */
function elementAt(s: string, i: number): XmlEl {
  NAME.lastIndex = i + 1;
  const m = NAME.exec(s);
  if (!m) throw new Error("bad tag");
  const name = m[0];
  const local = name.includes(":") ? name.slice(name.indexOf(":") + 1) : name;
  const openEnd = tagEnd(s, i);
  if (s[openEnd - 2] === "/") return { name, local, start: i, end: openEnd, openEnd, closeStart: openEnd };
  let depth = 1;
  let j = openEnd;
  while (j < s.length) {
    const lt = s.indexOf("<", j);
    if (lt < 0) break;
    const other = skipOther(s, lt);
    if (other >= 0) {
      j = other;
      continue;
    }
    const e = tagEnd(s, lt);
    if (s[lt + 1] === "/") {
      if (--depth === 0) return { name, local, start: i, end: e, openEnd, closeStart: lt };
    } else if (s[e - 2] !== "/") depth++;
    j = e;
  }
  throw new Error(`unclosed <${name}>`);
}

/** Child elements of the text range [from, to) (the content of one element, or a whole document). */
export function scanChildren(s: string, from: number, to: number): XmlEl[] {
  const out: XmlEl[] = [];
  let j = from;
  while (j < to) {
    const lt = s.indexOf("<", j);
    if (lt < 0 || lt >= to) break;
    const other = skipOther(s, lt);
    if (other >= 0) {
      j = other;
      continue;
    }
    if (s[lt + 1] === "/") break; // end tag of the enclosing element
    const el = elementAt(s, lt);
    out.push(el);
    j = el.end;
  }
  return out;
}

/** Child elements of an element. */
export const childrenOf = (s: string, el: XmlEl): XmlEl[] => (el.openEnd === el.end ? [] : scanChildren(s, el.openEnd, el.closeStart));

/** Root element of a document. */
export function rootOf(s: string): XmlEl {
  const r = scanChildren(s, 0, s.length)[0];
  if (!r) throw new Error("no root element");
  return r;
}

/** First child with this local name. */
export const childNamed = (s: string, el: XmlEl, local: string): XmlEl | undefined => childrenOf(s, el).find((c) => c.local === local);

/** Descendants with this local name, in document order (like io/xml.ts `descendants`). */
export function descendantsNamed(s: string, el: XmlEl, local: string, out: XmlEl[] = []): XmlEl[] {
  for (const c of childrenOf(s, el)) {
    if (c.local === local) out.push(c);
    descendantsNamed(s, c, local, out);
  }
  return out;
}

export const textOfEl = (s: string, el: XmlEl) => s.slice(el.start, el.end);
