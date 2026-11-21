// Office Surgeon × password-protected DOCX / XLSX (ui/actions.ts → OpenCtx.decrypted).
// The decrypted package must never become a plaintext asset of the document (.omw, Shuttle Journal):
// such files are saved anew (with a note) and re-encrypted by protectOutput. Test passwords are throwaway values.
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const saved: { name: string; bytes: Uint8Array | string }[] = [];
vi.mock("../../src/io/platform", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    saveFile: async (name: string, bytes: Uint8Array | string, _f: unknown, existing?: string | null) => {
      saved.push({ name, bytes });
      return existing ?? `C:/fake/${name}`;
    },
  };
});
const protectAnswers: any[] = [];
vi.mock("../../src/ui/shell/SecurityDialogs", () => ({
  askProtection: async () => (protectAnswers.length ? protectAnswers.shift() : null),
}));

import { newDocument, newTable, newText, type TextNode } from "../../src/core/types";
import { encryptOffice, isEncryptedOffice, decryptOffice } from "../../src/io/crypto/office";
import { setPasswordAsker } from "../../src/io/crypto/session";
import { exportXlsx } from "../../src/io/formats/xlsx";
import { exportDocx } from "../../src/io/office";
import { packOmw } from "../../src/io/omw";
import { exportAs, fileToPages, importFile } from "../../src/ui/actions";
import { S, freshStore, installDom } from "../coverage/helpers";

beforeAll(() => {
  installDom();
  (globalThis as any).alert = () => {};
  (globalThis as any).confirm = () => true;
});
beforeEach(() => {
  saved.length = 0;
  protectAnswers.length = 0;
});

const MARK = "omni-seal-7f3a"; // unique text of the protected original

function sampleDocx(): Uint8Array {
  const d = newDocument("오메 비밀 메모");
  d.pages[0].nodes.push(newText(`${MARK} 첫 문단`));
  return exportDocx(d.pages);
}

/** Every stored asset blob of a packed .omw whose content is an Office package (PK + [Content_Types].xml). */
function officeAssetsIn(omw: Uint8Array): string[] {
  const out: string[] = [];
  const files = unzipSync(omw);
  for (const [name, data] of Object.entries(files)) {
    if (data[0] !== 0x50 || data[1] !== 0x4b) continue;
    try {
      const inner = unzipSync(data);
      if (inner["[Content_Types].xml"]) out.push(name);
    } catch {
      /* not a zip */
    }
  }
  return out;
}

describe("password-protected Office files: no plaintext original kept", () => {
  it("importFile (DOCX): no Office asset, .omw has no plaintext package, export is re-encrypted", async () => {
    const enc = await encryptOffice(sampleDocx(), "qa-office-pw");
    expect(isEncryptedOffice(enc)).toBe(true);
    setPasswordAsker(async () => "qa-office-pw");
    freshStore();
    await importFile({ name: "secret.docx", path: null, bytes: enc });
    const doc = S().doc;
    expect(doc.pages.some((p) => p.source?.format === "docx")).toBe(true);
    expect(doc.pages.some((p) => p.source?.office)).toBe(false);
    expect(Object.values(doc.assets).some((a) => /officedocument/.test(a.mime))).toBe(false);
    const omw = packOmw(doc).bytes;
    expect(officeAssetsIn(omw)).toEqual([]);
    // the whole .omw: the marker text may be in the page JSON, never in a stored copy of document.xml
    expect(Object.keys(unzipSync(omw)).some((n) => /\.docx$|officedocument/.test(n))).toBe(false);

    // saving as DOCX: written anew (fallback note confirmed) and encrypted again with the same password
    protectAnswers.push({ mode: "same" });
    await exportAs("docx");
    const out = saved[saved.length - 1].bytes as Uint8Array;
    expect(isEncryptedOffice(out)).toBe(true);
    const plain = await decryptOffice(out, "qa-office-pw");
    expect(strFromU8(unzipSync(plain)["word/document.xml"])).toContain(MARK);
  }, 60_000);

  it("fileToPages (XLSX insert): no Office asset", async () => {
    const d = newDocument("오메 표");
    d.pages[0].nodes.push(newText("x"));
    d.pages[0].nodes.push(newTable([[MARK, "Omni"], ["1", "2"]]));
    const enc = await encryptOffice(exportXlsx(d.pages), "qa-office-pw2");
    setPasswordAsker(async () => "qa-office-pw2");
    const r = await fileToPages({ name: "secret.xlsx", path: null, bytes: enc });
    expect(r.pages.some((p) => p.source?.office)).toBe(false);
    expect(Object.values(r.assets).some((a) => /officedocument/.test(a.mime))).toBe(false);
  }, 60_000);

  it("an unprotected DOCX still keeps its original for the surgeon (control)", async () => {
    freshStore();
    await importFile({ name: "plain.docx", path: null, bytes: sampleDocx() });
    expect(S().doc.pages.some((p) => p.source?.office)).toBe(true);
    expect((S().doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TEXT") as TextNode | undefined)?.type).toBe("TEXT");
  }, 30_000);
});
