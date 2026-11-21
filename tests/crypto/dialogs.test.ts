// The real password / protection dialogs with no <SecurityDialogs/> mounted (tests, corpus runs,
// any headless use): every request must settle at once as "cancelled", never stay pending.

import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { askPasswordDialog, askProtection } from "../../src/ui/shell/SecurityDialogs";
import { askPassword } from "../../src/io/crypto/session";
import { encryptPdf } from "../../src/io/crypto/pdfEncrypt";
import { encryptOffice } from "../../src/io/crypto/office";
import { encryptOmw } from "../../src/io/crypto/omwCrypt";
import { importFile, lastImport } from "../../src/ui/actions";
import { packOmw } from "../../src/io/omw";
import { newDocument } from "../../src/core/types";
import { strToU8, zipSync } from "fflate";
import { freshStore, installDom, installPdfWorker } from "../coverage/helpers";

beforeAll(async () => {
  installDom();
  await installPdfWorker();
  (globalThis as any).alert = () => {};
});

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`still pending after ${ms}ms`)), ms))]);

describe("security dialogs without a mounted UI", () => {
  it("resolve null immediately (the app's asker is installed by importing the module)", async () => {
    await expect(within(askPasswordDialog({ title: "t", message: "m" }), 500)).resolves.toBeNull();
    await expect(within(askPassword({ title: "t", message: "m" }), 500)).resolves.toBeNull();
    await expect(within(askProtection({ ext: "omw", wasProtected: true, canReuse: true, supported: true }), 500)).resolves.toBeNull();
  });

  it("an encrypted PDF / Office / .omw opened headless ends quickly as cancelled or '암호 필요'", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const files = [
      { name: "h.pdf", bytes: await encryptPdf(await pdf.save(), "qa-headless-1") },
      { name: "h.docx", bytes: await encryptOffice(zipSync({ "[Content_Types].xml": strToU8("<Types/>") }), "qa-headless-2") },
      { name: "h.omw", bytes: await encryptOmw(packOmw(newDocument("h")).bytes, "qa-headless-3") },
    ];
    for (const f of files) {
      freshStore();
      const t0 = performance.now();
      await within(importFile({ ...f, path: null }), 10_000);
      expect(performance.now() - t0).toBeLessThan(10_000);
    }
    expect(lastImport?.error ?? "").not.toMatch(/still pending/);
  }, 60_000);
});
