// Namespace-agnostic XML traversal that works with both browser DOMParser and xmldom.

export function parseXml(text: string): Document {
  const P: typeof DOMParser = (globalThis as any).DOMParser;
  if (!P) throw new Error("DOMParser unavailable");
  return new P().parseFromString(text, "application/xml") as Document;
}

const local = (n: Node) => (n as Element).localName ?? (n.nodeName.includes(":") ? n.nodeName.split(":")[1] : n.nodeName);

export function children(el: Node, name?: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && (!name || local(c) === name)) out.push(c as Element);
  return out;
}

export function child(el: Node, name: string): Element | undefined {
  for (let c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1 && local(c) === name) return c as Element;
  return undefined;
}

export function descendants(el: Node, name: string, out: Element[] = []): Element[] {
  for (let c = el.firstChild; c; c = c.nextSibling)
    if (c.nodeType === 1) {
      if (local(c) === name) out.push(c as Element);
      descendants(c, name, out);
    }
  return out;
}

/** Attribute by local name regardless of prefix. */
export function attr(el: Element, name: string): string | null {
  if (el.hasAttribute(name)) return el.getAttribute(name);
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.localName === name || a.name.endsWith(":" + name)) return a.value;
  }
  return null;
}

export function textOf(el: Node): string {
  let s = "";
  for (let c = el.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 3 || c.nodeType === 4) s += c.nodeValue ?? "";
    else if (c.nodeType === 1) s += textOf(c);
  }
  return s;
}

export const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
