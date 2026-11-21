// Protection flows around the crypto primitives: PDF password prompts (pdf.ts openPdf), and the
// save / export / open paths in ui/actions.ts that must never write a protected document in the clear.
// Dialogs and the file system are replaced by in-memory fakes; test passwords are throwaway values.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

// ---- fakes: save target and the protection dialog ----------------------------------------------
const saved: { name: string; bytes: Uint8Array | string; existing: string | null | undefined }[] = [];
vi.mock("../../src/io/platform", async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    saveFile: async (name: string, bytes: Uint8Array | string, _f: unknown, existing?: string | null) => {
      saved.push({ name, bytes, existing });
      return existing ?? `C:/fake/${name}`;
    },
  };
});
type Choice = { mode: "same" } | { mode: "none" } | { mode: "new"; password: string } | null;
const protectAnswers: Choice[] = [];
const protectAsked: any[] = [];
vi.mock("../../src/ui/shell/SecurityDialogs", () => ({
  askProtection: async (req: any) => {
    protectAsked.push(req);
    return protectAnswers.length ? protectAnswers.shift()! : null;
  },
}));

import { setPasswordAsker } from "../../src/io/crypto/session";
import { encryptPdf } from "../../src/io/crypto/pdfEncrypt";
import { decryptOmw, encryptOmw, isEncryptedOmw } from "../../src/io/crypto/omwCrypt";
import { importPdf } from "../../src/io/pdf";
import { packOmw } from "../../src/io/omw";
import { newDocument, newText } from "../../src/core/types";
import { exportAs, importFile, openDemoIfRequested, saveDoc } from "../../src/ui/actions";
import { S, freshStore, installDom, installPdfWorker } from "../coverage/helpers";

beforeAll(async () => {
  installDom();
  await installPdfWorker();
  (globalThis as any).alert = () => {};
});
beforeEach(() => {
  saved.length = 0;
  protectAnswers.length = 0;
  protectAsked.length = 0;
});

async function samplePdf(text: string) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  d.addPage([300, 200]).drawText(text, { x: 20, y: 100, size: 14, font: f });
  return d.save();
}

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);

// ------------------------------------------------------------------------------------------------
describe("password-protected PDF open (pdf.ts openPdf)", () => {
  it("fails fast with '암호 필요' when there is no one to ask (asker returns null)", async () => {
    setPasswordAsker(async () => null);
    const enc = await encryptPdf(await samplePdf("unique-a"), "qa-pw-1");
    const t0 = performance.now();
    await expect(withTimeout(importPdf(enc, "a.pdf"), 10_000)).rejects.toThrow(/암호/);
    expect(performance.now() - t0).toBeLessThan(10_000);
  }, 20_000);

  it("fails fast when the asker itself throws (no hang, no unhandled rejection)", async () => {
    setPasswordAsker(async () => {
      throw new Error("dialog unavailable");
    });
    const enc = await encryptPdf(await samplePdf("unique-b"), "qa-pw-2");
    await expect(withTimeout(importPdf(enc, "b.pdf"), 10_000)).rejects.toThrow(/암호/);
  }, 20_000);

  it("gives up after repeated wrong passwords instead of looping", async () => {
    let n = 0;
    setPasswordAsker(async () => `wrong-${n++}`);
    const enc = await encryptPdf(await samplePdf("unique-c"), "qa-pw-3");
    await expect(withTimeout(importPdf(enc, "c.pdf"), 15_000)).rejects.toThrow(/암호/);
    expect(n).toBeLessThanOrEqual(5);
  }, 30_000);

  it("opens with the right password and marks the pages as protected (secret id only)", async () => {
    setPasswordAsker(async () => "qa-pw-4");
    const enc = await encryptPdf(await samplePdf("unique-d"), "qa-pw-4");
    const { pages } = await withTimeout(importPdf(enc, "d.pdf"), 15_000);
    expect(pages[0].source?.protection?.scheme).toBe("pdf");
    expect(JSON.stringify(pages)).not.toContain("qa-pw-4");
  }, 30_000);

  it("importFile reports the refusal through lastImport instead of hanging", async () => {
    setPasswordAsker(async () => null);
    freshStore();
    const enc = await encryptPdf(await samplePdf("unique-e"), "qa-pw-5");
    await withTimeout(importFile({ name: "e.pdf", path: null, bytes: enc }), 10_000);
    const { lastImport } = await import("../../src/ui/actions");
    expect(lastImport?.error).toMatch(/암호/);
  }, 20_000);
});

// ------------------------------------------------------------------------------------------------
describe("save / export never silently drop protection (ui/actions.ts)", () => {
  const plainDoc = () => {
    const d = newDocument("보호 시험");
    d.pages[0].nodes.push(newText("qa-secret-content"));
    return d;
  };
  const lastBytes = () => saved[saved.length - 1].bytes as Uint8Array;

  it("after '암호 걸어 저장' with a new password, the next plain save stays encrypted", async () => {
    freshStore(plainDoc());
    protectAnswers.push({ mode: "new", password: "qa-new-pw" });
    await saveDoc(false, true);
    expect(isEncryptedOmw(lastBytes())).toBe(true);
    S().set({ dirty: true });
    // the next Ctrl+S: must ask again and offer the same password
    protectAnswers.push({ mode: "same" });
    await saveDoc();
    expect(protectAsked.length).toBe(2);
    expect(protectAsked[1]).toMatchObject({ wasProtected: true, canReuse: true });
    expect(isEncryptedOmw(lastBytes())).toBe(true);
    await expect(decryptOmw(lastBytes(), "qa-new-pw")).resolves.toBeInstanceOf(Uint8Array);
  }, 60_000);

  it("changing the password: 'same' afterwards reuses the new password, not the old one", async () => {
    setPasswordAsker(async () => "qa-old-pw");
    const enc = await encryptOmw(packOmw(plainDoc()).bytes, "qa-old-pw");
    freshStore();
    await importFile({ name: "x.omw", path: "C:/fake/x.omw", bytes: enc });
    protectAnswers.push({ mode: "new", password: "qa-changed-pw" });
    await saveDoc();
    protectAnswers.push({ mode: "same" });
    await saveDoc();
    await expect(decryptOmw(lastBytes(), "qa-changed-pw")).resolves.toBeInstanceOf(Uint8Array);
  }, 60_000);

  it("a cancelled open of another encrypted .omw keeps the current document protected", async () => {
    setPasswordAsker(async () => "qa-a-pw");
    const a = await encryptOmw(packOmw(plainDoc()).bytes, "qa-a-pw");
    freshStore();
    await importFile({ name: "a.omw", path: "C:/fake/a.omw", bytes: a });
    // open B, cancel the password prompt
    const b = await encryptOmw(packOmw(newDocument("B")).bytes, "qa-b-pw");
    setPasswordAsker(async () => null);
    await importFile({ name: "b.omw", path: "C:/fake/b.omw", bytes: b });
    // A is still open; saving it must not write plaintext without asking
    protectAnswers.push({ mode: "same" });
    await saveDoc();
    expect(protectAsked.length).toBe(1);
    expect(isEncryptedOmw(lastBytes())).toBe(true);
  }, 60_000);

  it("'암호 걸어 내보내기' on a text format still asks (and does not silently write plain text)", async () => {
    freshStore(plainDoc());
    protectAnswers.push(null); // cancel
    await exportAs("txt", true);
    expect(protectAsked.length).toBe(1);
    expect(protectAsked[0]).toMatchObject({ ext: "txt", supported: false });
    expect(saved.length).toBe(0);
  }, 30_000);

  it("a new document does not inherit the previous file's .omw protection", async () => {
    setPasswordAsker(async () => "qa-c-pw");
    const c = await encryptOmw(packOmw(plainDoc()).bytes, "qa-c-pw");
    freshStore();
    await importFile({ name: "c.omw", path: "C:/fake/c.omw", bytes: c });
    const { newFile } = await import("../../src/ui/actions");
    S().set({ dirty: false });
    newFile();
    await saveDoc();
    expect(protectAsked.length).toBe(0);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------
describe(".omw header is untrusted until the tag verifies", () => {
  it("rejects an absurd PBKDF2 iteration count instead of hanging", async () => {
    const { strFromU8, strToU8, unzipSync, zipSync } = await import("fflate");
    const enc = await encryptOmw(new Uint8Array([1, 2, 3]), "qa-iter-pw");
    const files = unzipSync(enc);
    const h = JSON.parse(strFromU8(files["encryption.json"]));
    for (const it of [1e12, 0, -5, 1.5, "600000"]) {
      files["encryption.json"] = strToU8(JSON.stringify({ ...h, iterations: it }));
      const t0 = performance.now();
      await expect(decryptOmw(zipSync(files), "qa-iter-pw")).rejects.toThrow(/반복 횟수/);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe("browser demo (?demo=)", () => {
  it("only fetches same-origin demo files", async () => {
    const calls: string[] = [];
    const g = globalThis as any;
    const prev = { location: g.location, fetch: g.fetch };
    g.location = new URL("https://omniweave.example/app/?demo=https://evil.example/x.omw");
    g.fetch = async (u: any) => {
      calls.push(String(u));
      return { ok: false } as any;
    };
    try {
      await openDemoIfRequested();
      g.location = new URL("https://omniweave.example/app/?demo=//evil.example/x.omw");
      await openDemoIfRequested();
      expect(calls).toEqual([]);
      g.location = new URL("https://omniweave.example/app/?demo");
      await openDemoIfRequested();
      expect(calls.length).toBe(1);
      expect(new URL(calls[0], "https://omniweave.example/app/").origin).toBe("https://omniweave.example");
    } finally {
      g.location = prev.location;
      g.fetch = prev.fetch;
    }
  });
});
