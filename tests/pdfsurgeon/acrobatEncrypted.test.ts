// PDFs encrypted by real Acrobat (qa/interop/adobe-made/acro_encrypted_*.pdf, test password omw-test-1234):
// Omniweave decrypts AES-256 (V5 R6) and AES-128 (V4 R4) and refuses a wrong password.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decryptPdf, isEncrypted, PasswordError } from "../../src/io/pdfsurgeon/decrypt";
import { ROOT, openJs } from "./helpers";

const PW = "omw-test-1234";
const ref = (name: string) => {
  const p = join(ROOT, "qa/interop/adobe-made", name);
  return existsSync(p) ? new Uint8Array(readFileSync(p)) : null;
};

for (const [name, V, R, method, bits] of [
  ["acro_encrypted_r6.pdf", 5, 6, "AESV3", 256],
  ["acro_encrypted_aes128.pdf", 4, 4, "AESV2", 128],
] as const) {
  const bytes = ref(name);
  describe.skipIf(!bytes)(`Acrobat-encrypted ${name}`, () => {
    it("decrypts with the test password to a readable 2-page PDF", async () => {
      expect(isEncrypted(bytes!)).toBe(true);
      const { plain, info } = await decryptPdf(bytes!, PW);
      expect({ V: info.V, R: info.R, method: info.method, keyBits: info.keyBits }).toEqual({ V, R, method, keyBits: bits });
      expect(isEncrypted(plain)).toBe(false);
      const js = await openJs(plain);
      expect(js.numPages).toBe(2);
    });

    it("refuses a wrong password", async () => {
      await expect(decryptPdf(bytes!, "wrong-password")).rejects.toBeInstanceOf(PasswordError);
    });
  });
}
