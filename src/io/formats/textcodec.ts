// Text decoding with BOM / UTF-8 / legacy Korean (CP949 = EUC-KR superset in WHATWG Encoding) detection,
// and encoding back to the original encoding so a .bat saved by Omniweave still runs in a Korean console.

export interface DecodedText {
  text: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be" | "euc-kr";
  bom: boolean;
  eol: "\r\n" | "\n";
  /** the decoded text before line ends were made "\n" (BOM removed) */
  raw?: string;
}

export function decodeText(b: Uint8Array): DecodedText {
  let encoding: DecodedText["encoding"] = "utf-8";
  let bom = false;
  let text: string;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    bom = true;
    text = new TextDecoder("utf-8").decode(b.subarray(3));
  } else if (b[0] === 0xff && b[1] === 0xfe) {
    bom = true;
    encoding = "utf-16le";
    text = new TextDecoder("utf-16le").decode(b.subarray(2));
  } else if (b[0] === 0xfe && b[1] === 0xff) {
    bom = true;
    encoding = "utf-16be";
    text = new TextDecoder("utf-16be").decode(b.subarray(2));
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(b);
    } catch {
      try {
        text = new TextDecoder("euc-kr").decode(b);
        encoding = "euc-kr";
      } catch {
        text = new TextDecoder("utf-8").decode(b);
      }
    }
  }
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length;
  return { text: text.replace(/\r\n?/g, "\n"), raw: text, encoding, bom, eol: crlf > 0 && crlf >= lf / 2 ? "\r\n" : "\n" };
}

let eucKrMap: Map<string, number> | null = null;
function eucKrTable(): Map<string, number> {
  if (eucKrMap) return eucKrMap;
  eucKrMap = new Map();
  const dec = new TextDecoder("euc-kr");
  const pair = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++)
    for (let trail = 0x41; trail <= 0xfe; trail++) {
      pair[0] = lead;
      pair[1] = trail;
      const ch = dec.decode(pair);
      if (ch.length === 1 && ch !== "�" && !eucKrMap.has(ch)) eucKrMap.set(ch, (lead << 8) | trail);
    }
  return eucKrMap;
}

export function encodeText(text: string, opts: { encoding?: string; bom?: boolean; eol?: "\r\n" | "\n" } = {}): Uint8Array {
  const s = opts.eol === "\r\n" ? text.replace(/\r?\n/g, "\r\n") : text;
  const enc = opts.encoding ?? "utf-8";
  if (enc === "utf-16le" || enc === "utf-16be") {
    const out = new Uint8Array(2 + s.length * 2);
    const le = enc === "utf-16le";
    out[0] = le ? 0xff : 0xfe;
    out[1] = le ? 0xfe : 0xff;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out[2 + i * 2] = le ? c & 0xff : c >> 8;
      out[3 + i * 2] = le ? c >> 8 : c & 0xff;
    }
    return out;
  }
  if (enc === "euc-kr") {
    const map = eucKrTable();
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      if (c < 0x80) out.push(c);
      else {
        const v = map.get(ch);
        if (v === undefined) out.push(0x3f); // "?" — not representable in CP949
        else out.push(v >> 8, v & 0xff);
      }
    }
    return new Uint8Array(out);
  }
  const body = new TextEncoder().encode(s);
  if (!opts.bom) return body;
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return out;
}
