// Phone parity (휴대폰 = 설치본 기능): protected files open on the phone screen with the phone's own password sheet —
// the desktop's dialog module no longer takes the question over just by being loaded (the cause of "암호 PDF조차 못
// 연다") — every registry format reaches the phone viewer, the password the viewer used is offered to the next open,
// and the phone app carries the on-device AI models. Test files are made here (omni- names, author "Omniweave QA").
import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "fs";
import { askPassword, getPasswordAsker, setPasswordAsker } from "../src/io/crypto/session";
import { encryptOffice } from "../src/io/crypto/office";
import { encryptOmw } from "../src/io/crypto/omwCrypt";
import { newDocument } from "../src/core/types";
import { packOmw } from "../src/io/omw";
import { openPages, viewKind, knownPassword } from "../src/ui/mobile/openDoc";
import { offerPassword, phonePasswordAsker } from "../src/ui/mobile/prompt";
import { sniffExt } from "../src/ui/mobile/MobileApp";
import { MOBILE_DROP } from "../vite.config";

const PW = "omw-test-1234";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

/** the smallest Word document: one paragraph, author Omniweave QA */
function omniDocx(text: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
    ),
    "docProps/core.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Omniweave QA</dc:creator><cp:lastModifiedBy>Omniweave QA</cp:lastModifiedBy></cp:coreProperties>`,
    ),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
    ),
  });
}

/** answers every password question with `pw`, counting them */
function answering(pw: string) {
  const asked: boolean[] = [];
  setPasswordAsker(async (req) => (asked.push(!!req.retry), pw));
  return asked;
}

describe("phone: protected files", () => {
  it("loading the desktop's password dialog module does not take the phone's question away", async () => {
    const mine = async () => "x";
    setPasswordAsker(mine);
    await import("../src/ui/shell/SecurityDialogs");
    await import("../src/ui/actions");
    expect(getPasswordAsker()).toBe(mine);
  });

  it("opens a password-protected Word file in the phone viewer (desktop open, phone question)", async () => {
    const enc = await encryptOffice(omniDocx("오메 휴대폰 암호 문서"), PW);
    const asked = answering(PW);
    const v = await openPages("omni-pw.docx", enc);
    expect(asked).toEqual([false]);
    expect(v.pages.length).toBeGreaterThan(0);
    expect(v.text(0)).toContain("오메 휴대폰 암호 문서");
    // the editor / PC screen opened next tries this password before asking
    expect(knownPassword(enc)).toBe(PW);
  });

  it("asks again after a wrong password, and a cancel says so", async () => {
    const enc = await encryptOffice(omniDocx("omni"), PW);
    let n = 0;
    setPasswordAsker(async (req) => (n++ === 0 ? (expect(req.retry).toBeFalsy(), "wrong") : (expect(req.retry).toBe(true), PW)));
    expect((await openPages("omni-pw2.docx", enc)).pages.length).toBeGreaterThan(0);
    setPasswordAsker(async () => null);
    await expect(openPages("omni-pw3.docx", enc)).rejects.toThrow();
  });

  it("opens a password-protected .omw", async () => {
    const doc = newDocument("omni-pw");
    const enc = await encryptOmw(packOmw(doc).bytes, PW);
    answering(PW);
    expect((await openPages("omni-pw.omw", enc)).pages.length).toBe(doc.pages.length);
  });

  it("the phone sheet answers an offered password once, then asks", async () => {
    const asker = phonePasswordAsker((k) => k);
    setPasswordAsker(asker);
    offerPassword("seen-before");
    expect(await askPassword({ title: "t", message: "m" })).toBe("seen-before");
    // nothing offered any more: the sheet is asked (no sheet in a test → window.prompt-less fallback, null)
    const second = await Promise.race([askPassword({ title: "t", message: "m" }), new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(second === null || second === "pending").toBe(true);
  });
});

describe("phone: every format the PC program opens", () => {
  it("sends legacy Office, HWP, text, picture and media files to a viewer", () => {
    for (const n of ["a.hwp", "a.doc", "a.xls", "a.ppt", "a.csv", "a.md", "a.html", "a.epub", "a.tif", "a.heic"]) expect(viewKind(n)).toBe("pages");
    for (const n of ["a.mp3", "a.wav", "a.mp4", "a.webm"]) expect(viewKind(n)).toBe("media");
    expect(viewKind("a.pdf")).toBe("pdf");
  });

  it("tells HWP / Word / PowerPoint / Excel 97 files apart without a name", () => {
    const cfb = (stream: string) => {
      const b = new Uint8Array(2048);
      b.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
      const u16 = [...stream].flatMap((c) => [c.charCodeAt(0), 0]);
      b.set(u16, 1024);
      return b;
    };
    expect(sniffExt(cfb("FileHeader"))).toBe("hwp");
    expect(sniffExt(cfb("WordDocument"))).toBe("doc");
    expect(sniffExt(cfb("PowerPoint Document"))).toBe("ppt");
    expect(sniffExt(cfb("Workbook"))).toBe("xls");
  });

  it("the phone app ships the on-device AI models and prints through Android", () => {
    expect(MOBILE_DROP).toEqual(["version.json"]);
    expect(readFileSync("package.json", "utf8")).toMatch(/"build:mobile": "[^"]*ocr-models\.mjs/);
    expect(readFileSync("src-tauri/src/lib.rs", "utf8")).toContain("mobile::print_staged");
    expect(readFileSync("src-tauri/gen/android/app/src/main/java/app/omniweave/studio/SharePlugin.kt", "utf8")).toContain("PrintManager");
    const assoc = JSON.parse(readFileSync("src-tauri/tauri.android.conf.json", "utf8")).bundle.fileAssociations.flatMap((a: { ext: string[] }) => a.ext);
    for (const e of ["hwp", "doc", "xls", "ppt", "csv", "epub"]) expect(assoc).toContain(e);
  });
});
