// Test material must not carry the name of whoever made it. Word·Excel·PowerPoint·한글·Acrobat write the PC's user
// name into document properties (author, last saved by, company), PDF Info/XMP and binary summary streams; the QA
// generators (qa/interop/scripts/qa_author.ps1) and qa/interop/scripts/scrub_author.mjs replace it with 'Omniweave QA'.
//  1. the account name of the PC running the tests (os.userInfo — never written here) appears nowhere in the material:
//     raw bytes (ASCII any case, UTF-16 LE/BE), ZIP entries, PDF Flate streams, Office packages encrypted with the
//     repository's test password. Skipped when the account name is short or generic (CI runners, 'user', …).
//  2. every author-type field holds an allowed value: 'Omniweave QA', empty, a same-length 'QA---' stand-in or a
//     synthetic test id — on any PC, so a real name (another person's, too) fails here even in CI.
// Values are never printed in full (only their length), so a failure does not copy a name into a log.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { inflateRawSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { readCfb } from "../src/io/formats/cfb";
import { decryptOffice, isEncryptedOffice } from "../src/io/crypto/office";
import { decryptPdf, isEncrypted as isEncryptedPdf } from "../src/io/pdfsurgeon/decrypt";

const ROOTS = ["qa", "docs", "tests", "public", "src/assets", "assets", "website", "marketing"];
const EXT = /\.(docx|docm|dotx|pptx|pptm|potx|xlsx|xlsm|xltx|hwpx|omw|odt|odp|ods|doc|dot|ppt|xls|hwp|pdf|ai|eps|psd)$/i;
const TEST_PASSWORD = "omw-test-1234"; // the throwaway password of the encrypted fixtures (qa/interop/README.md)
const ALLOWED = (v: string) => /^(Omniweave QA|Omniweave|omw-test|QA-*|)$/.test(v.trim());
/** per field: comment initials 'OQ' (Omniweave QA's), Word's built-in first revision author 'Unknown' */
const allowedFor = (field: string, v: string) => ALLOWED(v) || (/initials$/.test(field) && v.trim() === "OQ") || (field === "DOC SttbfRMark" && v === "Unknown");
const GENERIC = new Set(["user", "users", "admin", "administrator", "runner", "root", "test", "tester", "guest", "build", "builder", "ci", "vscode", "node", "docker", "ubuntu", "runneradmin", "vsts", "appveyor", "travis", "jenkins", "circleci", "default", "owner", "pc", "omniweave", "qa"]);

function listFiles(): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\0").filter((f) => f && EXT.test(f) && existsSync(f));
  } catch {
    const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d).flatMap((n) => (n === "node_modules" ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)])) : []);
    return ROOTS.flatMap(walk).filter((f) => EXT.test(f));
  }
}

// ---- reading helpers ----
interface Entry {
  name: string;
  data: Buffer | null;
}
function zipEntries(b: Buffer): Entry[] | null {
  if (b.length < 22 || b[0] !== 0x50 || b[1] !== 0x4b) return null;
  const e = b.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  if (e < 0) return null;
  const out: Entry[] = [];
  let p = b.readUInt32LE(e + 16);
  for (let k = b.readUInt16LE(e + 10); k > 0 && p + 46 <= b.length && b.readUInt32LE(p) === 0x02014b50; k--) {
    const fl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    const method = b.readUInt16LE(p + 10), cs = b.readUInt32LE(p + 20), lo = b.readUInt32LE(p + 42);
    const name = b.toString("utf8", p + 46, p + 46 + fl);
    const at = lo + 30 + b.readUInt16LE(lo + 26) + b.readUInt16LE(lo + 28);
    let data: Buffer | null = null;
    try {
      data = method === 8 ? inflateRawSync(b.subarray(at, at + cs)) : method === 0 ? b.subarray(at, at + cs) : null;
    } catch {
      data = null; // encrypted HWPX entry
    }
    out.push({ name, data });
    p += 46 + fl + xl + cl;
  }
  return out;
}
/** a PDF encrypted with the repository's test password, decrypted, and its streams (strings and streams are ciphertext otherwise) */
async function pdfPlain(b: Buffer): Promise<Buffer[]> {
  if (b.subarray(0, 5).toString() !== "%PDF-" || !isEncryptedPdf(new Uint8Array(b))) return [];
  try {
    const p = Buffer.from((await decryptPdf(new Uint8Array(b), TEST_PASSWORD)).plain);
    return [p, ...pdfStreams(p)];
  } catch {
    return [Buffer.from("%%For: (<encrypted PDF unreadable>)")];
  }
}
function pdfStreams(b: Buffer): Buffer[] {
  const s = b.toString("latin1");
  if (!s.includes("endstream")) return [];
  const out: Buffer[] = [];
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const st = m.index! + m[0].length;
    const en = s.indexOf("endstream", st);
    if (en < 0) break;
    try {
      out.push(inflateSync(b.subarray(st, en)));
    } catch {
      /* not Flate, or a stream holding binary that happens to fail */
    }
  }
  const ai = aiNativeData(b, [s, ...out.map((d) => d.toString("latin1"))]);
  if (ai) out.push(ai === "unreadable" ? Buffer.from("%%For: (<AIPrivateData unreadable>)") : ai);
  return out;
}
/**
 * Illustrator's native data (AIPrivateData1…n, one compressed stream cut into 64 KB PDF streams — ZStandard since
 * Illustrator 24 '%AI24_ZStandard_Data', zlib before '%AI12_CompressedData'): it carries its own %%For: (the registered
 * user name) — the PDF header's %%For alone is not enough (found 2026-11-18). The references are looked for in the file
 * and in its decompressed streams (an object stream may hold the PieceInfo dictionary); the last definition of an object
 * wins (incremental saves). Data that is there but cannot be read is "unreadable" — reported, never skipped.
 */
function aiNativeData(b: Buffer, texts: string[]): Buffer | "unreadable" | null {
  const s = texts[0];
  const byIndex = new Map<number, string>();
  for (const t of texts) for (const m of t.matchAll(/\/AIPrivateData(\d+)\s+(\d+)\s+\d+\s+R/g)) byIndex.set(Number(m[1]), m[2]);
  if (!byIndex.size) return null;
  try {
    const parts = [...byIndex.entries()].sort((x, y) => x[0] - y[0]).map(([, n]) => {
      const defs = [...s.matchAll(new RegExp(`(?:^|[\\r\\n\\s])${n}\\s+\\d+\\s+obj\\b`, "g"))];
      const at = defs[defs.length - 1].index!;
      const st = s.indexOf("stream", at) + 6;
      const start = st + (s[st] === "\r" && s[st + 1] === "\n" ? 2 : 1);
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(s.slice(at, st));
      const len = direct ? Number(direct[1]) : -1;
      if (len >= 0 &&/^\s*endstream/.test(s.slice(start + len, start + len + 12))) return b.subarray(start, start + len);
      let end = s.indexOf("endstream", start);
      if (s[end - 1] === "\n") end--;
      if (s[end - 1] === "\r") end--;
      return b.subarray(start, end);
    });
    const all = Buffer.concat(parts);
    const head = all.subarray(0, 24).toString("latin1");
    if (head.startsWith("%AI24_ZStandard_Data")) return zstdDecompressSync(all.subarray(20));
    if (head.startsWith("%AI12_CompressedData")) return inflateSync(all.subarray(20));
    if (head.startsWith("%!PS-Adobe") || head.startsWith("%AI")) return all; // stored without compression
    return "unreadable";
  } catch {
    return "unreadable";
  }
}
const lowerAscii = (b: Buffer) => {
  const o = Buffer.from(b);
  for (let i = 0; i < o.length; i++) if (o[i] >= 65 && o[i] <= 90) o[i] |= 32;
  return o;
};
function contains(b: Buffer, name: string): boolean {
  const lb = lowerAscii(b);
  const n = name.toLowerCase();
  return [Buffer.from(n, "latin1"), Buffer.from(n, "utf16le"), Buffer.from(n, "utf16le").swap16()].some((pat) => lb.indexOf(lowerAscii(pat)) >= 0) || (/[^\x00-\x7f]/.test(n) && b.indexOf(Buffer.from(name, "utf8")) >= 0);
}
async function decrypted(b: Buffer): Promise<Buffer | null> {
  try {
    return isEncryptedOffice(new Uint8Array(b)) ? Buffer.from(await decryptOffice(new Uint8Array(b), TEST_PASSWORD)) : null;
  } catch {
    return null;
  }
}

/**
 * User names that the 97-2003 binaries keep outside the summary streams: PowerPoint's "Current User" stream (the user
 * name of the last save, ANSI and UTF-16 — [MS-PPT] 2.3.2 CurrentUserAtom), Excel's WRITEACCESS record (0x005C,
 * [MS-XLS] 2.4.349), Word's saved-by list, comment owners and revision authors (FibRgFcLcb97 SttbSavedBy 71,
 * GrpXstAtnOwners 36, SttbfRMark 51 — [MS-DOC] 2.5.6).
 */
function oleUserNames(cfb: ReturnType<typeof readCfb>): [string, string][] {
  const out: [string, string][] = [];
  const cu = cfb.get("Current User");
  if (cu && cu.length >= 28) {
    const d = Buffer.from(cu);
    const len = d.readUInt16LE(20);
    if (len <= 255 && 28 + len <= d.length) {
      out.push(["PPT Current User (ANSI)", d.toString("latin1", 28, 28 + len)]);
      const u = 28 + len + 4;
      if (u + len * 2 <= d.length) out.push(["PPT Current User (UTF-16)", d.toString("utf16le", u, u + len * 2)]);
    }
  }
  const wb = cfb.get("Workbook") ?? cfb.get("Book");
  if (wb) {
    const d = Buffer.from(wb);
    for (let p = 0; p + 4 <= d.length; ) {
      const type = d.readUInt16LE(p), size = d.readUInt16LE(p + 2);
      if (type === 0x002f) break; // FILEPASS: what follows is encrypted
      if (type === 0x005c && size >= 3 && p + 4 + size <= d.length) {
        const cch = d.readUInt16LE(p + 4), hi = d[p + 6] & 1;
        const v = hi ? d.toString("utf16le", p + 7, Math.min(p + 4 + size, p + 7 + cch * 2)) : d.toString("latin1", p + 7, Math.min(p + 4 + size, p + 7 + cch));
        out.push(["XLS WRITEACCESS", v.trimEnd()]);
      }
      if (type === 0x000a) break; // EOF of the globals
      p += 4 + size;
    }
  }
  const word = cfb.get("WordDocument");
  if (word && word.length > 154) {
    const w = Buffer.from(word);
    const table = cfb.get(w[11] & 2 ? "1Table" : "0Table");
    const cb = w.readUInt16LE(152);
    if (table) {
      const t = Buffer.from(table);
      const pair = (i: number): [number, number] | null => (i < cb && 154 + i * 8 + 8 <= w.length ? [w.readUInt32LE(154 + i * 8), w.readUInt32LE(154 + i * 8 + 4)] : null);
      const sttb = (label: string, i: number) => {
        const fl = pair(i);
        if (!fl || !fl[1] || fl[0] + fl[1] > t.length) return;
        let p = fl[0];
        const ext = t.readUInt16LE(p) === 0xffff;
        if (ext) p += 2;
        const n = t.readUInt16LE(p), extra = t.readUInt16LE(p + 2);
        p += 4;
        for (let k = 0; k < n && p + 2 <= fl[0] + fl[1]; k++) {
          const cch = ext ? t.readUInt16LE(p) : t[p];
          p += ext ? 2 : 1;
          const v = ext ? t.toString("utf16le", p, p + cch * 2) : t.toString("latin1", p, p + cch);
          p += (ext ? cch * 2 : cch) + extra;
          // SttbSavedBy pairs (author, path): the paths are not names
          if (label !== "DOC SttbSavedBy" || k % 2 === 0) out.push([label, v]);
        }
      };
      sttb("DOC SttbSavedBy", 71);
      sttb("DOC SttbfRMark", 51);
      const at = pair(36);
      if (at && at[1] && at[0] + at[1] <= t.length) {
        for (let p = at[0]; p + 2 <= at[0] + at[1]; ) {
          const cch = t.readUInt16LE(p);
          out.push(["DOC comment owner", t.toString("utf16le", p + 2, p + 2 + cch * 2)]);
          p += 2 + cch * 2;
        }
      }
    }
  }
  return out;
}

/** author-type fields of one file: [field, value] */
async function authorFields(f: string, b: Buffer): Promise<[string, string][]> {
  const out: [string, string][] = [];
  const fromZip = (zb: Buffer, tag: string) => {
    for (const e of zipEntries(zb) ?? []) {
      if (!e.data || !/\.(xml|hpf)$/i.test(e.name)) continue;
      const x = e.data.toString("utf8");
      // any namespace prefix and attributes (another writer's dc:/cp: binding), app.xml Company·Manager, the <author>
      // list of XLSX comments; a value is the element's own text (a container such as dc:creator > rdf:Seq gives "")
      for (const m of x.matchAll(/<((?:[\w.-]+:)?(?:creator|lastModifiedBy|LastAuthor|Author|author|Company|Manager))(?:\s[^>]*?)?(?<!\/)>([^<]*)</g)) out.push([`${tag}${e.name} ${m[1]}`, m[2]]);
      for (const m of x.matchAll(/<opf:meta name="(creator|lastsaveby)"[^>]*>([^<]*)</g)) out.push([`${tag}${e.name} ${m[1]}`, m[2]]);
      for (const m of x.matchAll(/\s((?:[\w]+:)?(?:author|userId|initials))="([^"]*)"/g)) if (/comment|people|document|authors|threaded|person/i.test(e.name)) out.push([`${tag}${e.name} ${m[1]}`, m[2]]);
      // PowerPoint comment authors (p:cmAuthor name, modern p188:author name) and Excel's people (x18tc person displayName)
      if (/commentAuthors|authors|person/i.test(e.name)) for (const m of x.matchAll(/<(?:\w+:)?(cmAuthor|author|person)\b[^>]*?\s(name|displayName)="([^"]*)"/g)) out.push([`${tag}${e.name} ${m[1]} ${m[2]}`, m[3]]);
    }
  };
  fromZip(b, "");
  const plain = await decrypted(b);
  if (plain) fromZip(plain, "(암호 안) ");
  if (b.length > 512 && b.readUInt32LE(0) === 0xe011cfd0 && !plain) {
    // OLE summary information (Word·Excel·PowerPoint 97-2003, HWP 5): author 4, last saved by 8; company 15, manager 14
    try {
      const cfb = readCfb(new Uint8Array(b));
      for (const [stream, ids] of [["\u0005SummaryInformation", { 4: "Author", 8: "LastAuthor" }], ["\u0005HwpSummaryInformation", { 4: "Author", 8: "LastAuthor" }], ["\u0005DocumentSummaryInformation", { 14: "Manager", 15: "Company" }]] as const) {
        const s = cfb.get(stream);
        if (!s || s.length < 48) continue;
        const d = Buffer.from(s);
        const sec = d.readUInt32LE(44);
        const cnt = d.readUInt32LE(sec + 4);
        const cp = (() => {
          for (let i = 0; i < cnt; i++) if (d.readUInt32LE(sec + 8 + i * 8) === 1) return d.readUInt16LE(sec + d.readUInt32LE(sec + 12 + i * 8) + 4);
          return 0;
        })();
        for (let i = 0; i < cnt; i++) {
          const id = d.readUInt32LE(sec + 8 + i * 8);
          const label = (ids as Record<number, string>)[id];
          if (!label) continue;
          const o = sec + d.readUInt32LE(sec + 12 + i * 8);
          const type = d.readUInt32LE(o), len = d.readUInt32LE(o + 4);
          const v = type === 0x1f ? d.toString("utf16le", o + 8, o + 8 + len * 2) : type === 0x1e ? (cp === 1200 ? d.toString("utf16le", o + 8, o + 8 + len) : d.toString("latin1", o + 8, o + 8 + len)) : "";
          out.push([`OLE ${label}`, v.replace(/\0+$/, "")]);
        }
      }
      for (const [k, v] of oleUserNames(cfb)) out.push([k, v]);
    } catch {
      /* not a readable compound file */
    }
  }
  if (b.subarray(0, 5).toString() === "%PDF-" || /\.ai$/i.test(f)) {
    // an encrypted PDF's own strings are ciphertext: its hex strings are read only after decryption (pdfPlain)
    const cipher = b.subarray(0, 5).toString() === "%PDF-" && isEncryptedPdf(new Uint8Array(b));
    const raw = [b, ...pdfStreams(b)];
    for (const t of [...raw, ...(await pdfPlain(b))]) {
      const s = t.toString("latin1");
      const plainText = !(cipher && raw.includes(t));
      for (const m of s.matchAll(/\/Author\s*\(((?:\\.|[^\\)])*)\)/g)) {
        const raw = Buffer.from(m[1], "latin1");
        out.push(["PDF Info Author", raw[0] === 0xfe && raw[1] === 0xff ? Buffer.from(raw.subarray(2)).swap16().toString("utf16le") : m[1]]);
      }
      // a hex string author (<FEFF…> UTF-16BE or bytes)
      if (plainText) for (const m of s.matchAll(/\/Author\s*<([0-9A-Fa-f\s]*)>/g)) {
        const raw = Buffer.from(m[1].replace(/\s/g, ""), "hex");
        out.push(["PDF Info Author", raw[0] === 0xfe && raw[1] === 0xff ? Buffer.from(raw.subarray(2)).swap16().toString("utf16le") : raw.toString("latin1")]);
      }
      for (const m of s.matchAll(/<dc:creator>\s*<rdf:(?:Seq|Bag|Alt)>([\s\S]*?)<\/rdf:(?:Seq|Bag|Alt)>/g)) for (const li of m[1].matchAll(/<rdf:li[^>]*>([^<]*)</g)) out.push(["XMP dc:creator", li[1]]);
      for (const m of s.matchAll(/<(pdf:Author|xmp:Author)>([^<]*)</g)) out.push([`XMP ${m[1]}`, m[2]]);
      for (const m of s.matchAll(/\s(pdf:Author|dc:creator)="([^"]*)"/g)) out.push([`XMP ${m[1]}`, m[2]]);
      for (const m of s.matchAll(/%%For:\s*\(([^)]*)\)/g)) out.push(["PostScript %%For", m[1]]);
    }
  }
  return out;
}

const files = listFiles();
const masked = (v: string) => `<${v.length}자>`;
/** the public source tree has no qa/ (scripts/public-exclude.txt): only a few test files there, all still scanned */
const PUBLIC_TREE = !existsSync("qa");
const MIN = PUBLIC_TREE ? 0 : 20;

describe("QA material carries no personal names", () => {
  it("finds the material (the scan is not empty)", () => {
    expect(files.length).toBeGreaterThan(MIN);
  });

  it("reads %%For inside Illustrator's native data: ZStandard and zlib, split streams, indirect /Length; unreadable data is reported", async () => {
    const ps = Buffer.from("%!PS-Adobe-3.0\r%%Creator: Adobe Illustrator(R) 24.0\r%%For: (Some Body)\r%%EndComments\r", "latin1");
    const ai = (data: Buffer) => {
      const a = data.subarray(0, 12), c = data.subarray(12);
      return Buffer.concat([
        Buffer.from("%PDF-1.6\n1 0 obj\n<</Illustrator<</Private<</AIPrivateData2 3 0 R/AIPrivateData1 2 0 R>>>>>>\nendobj\n2 0 obj\n<</Length " + a.length + ">>stream\n"),
        a,
        Buffer.from("\nendstream\nendobj\n3 0 obj\n<</Length 4 0 R>>stream\r\n"),
        c,
        Buffer.from("\r\nendstream\nendobj\n4 0 obj\n" + c.length + "\nendobj\n"),
      ]);
    };
    const { zstdCompressSync, deflateSync } = await import("node:zlib");
    const fors = async (b: Buffer) => (await authorFields("x.ai", b)).filter(([k]) => k === "PostScript %%For").map(([, v]) => v);
    expect(await fors(ai(Buffer.concat([Buffer.from("%AI24_ZStandard_Data"), zstdCompressSync(ps)])))).toContain("Some Body");
    expect(await fors(ai(Buffer.concat([Buffer.from("%AI12_CompressedData"), deflateSync(ps)])))).toContain("Some Body");
    expect((await fors(ai(Buffer.concat([Buffer.from("%AI24_ZStandard_Data"), Buffer.from("not zstd at all")])))).some((v) => !ALLOWED(v))).toBe(true);
  });

  it("reads every author-type field whatever the name: core/app properties under any prefix, comment authors, people, OLE user names", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const pkg = Buffer.from(
      zipSync({
        "docProps/core.xml": strToU8(`<cp:coreProperties xmlns:cp="c" xmlns:ns0="d"><ns0:creator>Some Body</ns0:creator><cp:lastModifiedBy xml:lang="ko">Display Name</cp:lastModifiedBy></cp:coreProperties>`),
        "ppt/commentAuthors.xml": strToU8(`<p:cmAuthorLst><p:cmAuthor id="0" name="Comment Person" initials="CP" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`),
        "xl/persons/person.xml": strToU8(`<personList><person displayName="Thread Person" id="{1}" userId="x@y" providerId="AD"/></personList>`),
        "xl/comments1.xml": strToU8(`<comments><authors><author>Note Person</author></authors></comments>`),
      }),
    );
    const vals = (await authorFields("x.pptx", pkg)).filter(([k, v]) => !allowedFor(k, v)).map(([, v]) => v);
    for (const n of ["Some Body", "Display Name", "Comment Person", "CP", "Thread Person", "x@y", "Note Person"]) expect(vals).toContain(n);
    // the binaries' own user-name places are read (a committed PowerPoint and Excel file of each kind)
    const keys = async (f: string) => (await authorFields(f, readFileSync(f))).map(([k]) => k);
    if (existsSync("qa/interop/powerpoint-made/omni-ppt-metafile.ppt")) expect(await keys("qa/interop/powerpoint-made/omni-ppt-metafile.ppt")).toContain("PPT Current User (UTF-16)");
    const xls = files.find((f) => /\.xls$/i.test(f) && /excel-made/.test(f));
    if (xls) expect(await keys(xls)).toContain("XLS WRITEACCESS");
  });

  const account = userInfo().username ?? "";
  const skip = account.length < 4 || GENERIC.has(account.toLowerCase());
  it.skipIf(skip)("the account name of this PC is nowhere in the material (bytes, ZIP entries, PDF streams, encrypted packages)", async () => {
    const hits: string[] = [];
    for (const f of files) {
      const b = readFileSync(f);
      const where: string[] = [];
      if (contains(b, account)) where.push("bytes");
      for (const e of zipEntries(b) ?? []) if (e.data && contains(e.data, account)) where.push("zip:" + e.name);
      if (pdfStreams(b).some((d) => contains(d, account))) where.push("pdf stream");
      if ((await pdfPlain(b)).some((d) => contains(d, account))) where.push("암호 PDF 안");
      const plain = await decrypted(b);
      if (plain) for (const e of zipEntries(plain) ?? []) if (e.data && contains(e.data, account)) where.push("암호 안 zip:" + e.name);
      if (where.length) hits.push(`${f} (${[...new Set(where)].join(", ")})`);
    }
    expect(hits, "고치기: node qa/interop/scripts/scrub_author.mjs --password omw-test-1234 <파일>").toEqual([]);
  }, 180_000);

  it("author fields hold 'Omniweave QA' (or empty / a 'QA---' stand-in / a synthetic test id), never a person's name", async () => {
    const bad: string[] = [];
    let seen = 0;
    for (const f of files) {
      for (const [field, v] of await authorFields(f, readFileSync(f))) {
        seen++;
        if (!allowedFor(field, v)) bad.push(`${f}: ${field} = ${masked(v)}`);
      }
    }
    expect(seen).toBeGreaterThanOrEqual(PUBLIC_TREE ? 0 : 21); // the readers do find the fields
    expect(bad, "고치기: node qa/interop/scripts/scrub_author.mjs --name <그 이름> --password omw-test-1234 <파일>").toEqual([]);
  }, 180_000);
});
