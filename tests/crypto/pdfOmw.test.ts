import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { encryptPdf } from "../../src/io/crypto/pdfEncrypt";
import { decryptOmw, encryptOmw, isEncryptedOmw } from "../../src/io/crypto/omwCrypt";
import { newDocument, newText } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";

async function pdfjs() {
  const p: any = await import("pdfjs-dist");
  p.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
  return p;
}

async function samplePdf() {
  const d = await PDFDocument.create();
  d.setTitle("Secret Report");
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([300, 200]).drawText("Omniweave secret 42", { x: 20, y: 100, size: 14, font: f });
  d.addPage([300, 200]).drawText("second page", { x: 20, y: 100, size: 14, font: f });
  return d.save();
}

async function textOf(bytes: Uint8Array, password?: string) {
  const p = await pdfjs();
  const doc = await p.getDocument({ data: bytes.slice(), password, isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) out.push((await (await doc.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(""));
  const meta = await doc.getMetadata();
  await doc.destroy();
  return { pages: out, title: meta.info?.Title };
}

describe("PDF AES-256 (R6) encryption", () => {
  it("opens with the right password and keeps text, metadata and pages", async () => {
    const enc = await encryptPdf(await samplePdf(), "오메-비밀번호!");
    const text = new TextDecoder("latin1").decode(enc);
    expect(text).toMatch(/\/V 5/);
    expect(text).toMatch(/\/R 6/);
    expect(text).not.toContain("Secret Report"); // strings are encrypted
    const r = await textOf(enc, "오메-비밀번호!");
    expect(r.pages).toEqual(["Omniweave secret 42", "second page"]);
    expect(r.title).toBe("Secret Report");
  }, 30000);

  it("refuses without or with a wrong password", async () => {
    const enc = await encryptPdf(await samplePdf(), "correct horse");
    await expect(textOf(enc)).rejects.toThrow(/password/i);
    await expect(textOf(enc, "wrong")).rejects.toThrow(/password/i);
  }, 30000);

  it("owner password also opens it", async () => {
    const enc = await encryptPdf(await samplePdf(), "user-pw", { ownerPassword: "owner-pw" });
    expect((await textOf(enc, "owner-pw")).pages[0]).toBe("Omniweave secret 42");
  }, 30000);
});

describe(".omw encryption (AES-256-GCM)", () => {
  it("round-trips and hides the content", async () => {
    const doc = newDocument("기밀 문서 제목");
    doc.pages[0].nodes.push(newText("아주 비밀스러운 내용"));
    const plain = packOmw(doc).bytes;
    const enc = await encryptOmw(plain, "pw-1234");
    expect(isEncryptedOmw(enc)).toBe(true);
    expect(isEncryptedOmw(plain)).toBe(false);
    const raw = new TextDecoder().decode(enc);
    expect(raw).not.toContain("기밀");
    const back = unpackOmw(await decryptOmw(enc, "pw-1234"));
    expect(back.doc.title).toBe("기밀 문서 제목");
    await expect(decryptOmw(enc, "nope")).rejects.toThrow("WRONG_PASSWORD");
  }, 30000);
});
