// Password-protected HWPX (ODF-style package encryption declared in META-INF/manifest.xml).
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { existsSync, readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { newPage, newText } from "../../src/core/types";
import { decryptHwpx, encryptHwpx, isEncryptedHwpx } from "../../src/io/crypto/hwpx";
import { exportHwpx, parseHwpx } from "../../src/io/office";
import { formatForExt } from "../../src/io/formats";
import { getSecret, setPasswordAsker } from "../../src/io/crypto/session";

const PW = "omw-test-1234";
const REF = "qa/interop/adobe-made/hwpx_encrypted.hwpx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("HWPX password", () => {
  it.skipIf(!existsSync(REF))("decrypts the file 한글 2024 saved with the test password; a wrong password is refused", async () => {
    const enc = new Uint8Array(readFileSync(REF));
    expect(isEncryptedHwpx(enc)).toBe(true);
    await expect(decryptHwpx(enc, "wrong-password")).rejects.toThrow("WRONG_PASSWORD");
    const plain = await decryptHwpx(enc, PW);
    expect(isEncryptedHwpx(plain)).toBe(false);
    const paras = parseHwpx(plain);
    expect(paras.length).toBeGreaterThan(0);
    expect(paras.some((p) => p.runs.some((r) => r.text.trim()))).toBe(true);
  });

  it("encrypt → decrypt round trip; only content parts are encrypted", async () => {
    const page = newPage("DOCUMENT");
    page.nodes.push(newText("암호 문서 본문 Secret body"));
    const plain = exportHwpx([page], "암호");
    const enc = await encryptHwpx(plain, PW);
    expect(isEncryptedHwpx(enc)).toBe(true);
    const files = unzipSync(enc);
    expect(strFromU8(files["Contents/section0.xml"]).includes("Secret")).toBe(false);
    expect(strFromU8(files.mimetype)).toBe("application/hwp+zip");
    await expect(decryptHwpx(enc, "nope")).rejects.toThrow("WRONG_PASSWORD");
    const back = parseHwpx(await decryptHwpx(enc, PW));
    expect(back.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["암호 문서 본문 Secret body"]);
  });

  it("ODF's SHA1/1K checksum also tells a wrong password (instead of opening garbage)", async () => {
    const page = newPage("DOCUMENT");
    page.nodes.push(newText("SHA1 체크섬 본문"));
    const plain = exportHwpx([page], "t");
    const plainFiles = unzipSync(plain);
    const files = unzipSync(await encryptHwpx(plain, PW));
    let manifest = strFromU8(files["META-INF/manifest.xml"]);
    for (const [name, data] of Object.entries(plainFiles)) {
      const sha1 = new Uint8Array(await crypto.subtle.digest("SHA-1", data.slice(0, 1024)));
      const b64 = btoa(String.fromCharCode(...sha1));
      manifest = manifest.replace(new RegExp(`(full-path="${name.replace(/[.]/g, "\\.")}"[^>]*><odf:encryption-data) checksum-type="[^"]*" checksum="[^"]*"`), `$1 checksum-type="SHA1/1K" checksum="${b64}"`);
    }
    expect(manifest).toContain("SHA1/1K");
    expect(manifest).not.toContain("sha256-1k");
    files["META-INF/manifest.xml"] = strToU8(manifest);
    const enc = zipSync(files);
    await expect(decryptHwpx(enc, "nope")).rejects.toThrow("WRONG_PASSWORD");
    expect(parseHwpx(await decryptHwpx(enc, PW)).map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["SHA1 체크섬 본문"]);
  });

  it("opening a protected HWPX asks for the password (wrong first), keeps it only as a session secret", async () => {
    const page = newPage("DOCUMENT");
    page.nodes.push(newText("열기 시험"));
    const enc = await encryptHwpx(exportHwpx([page], "t"), PW);
    const asked: boolean[] = [];
    setPasswordAsker(async (req) => (asked.push(!!req.retry), asked.length === 1 ? "wrong" : PW));
    const opened = await formatForExt("hwpx")!.open!({ name: "p.hwpx", path: null, bytes: enc }, { confirm: () => true });
    expect(asked).toEqual([false, true]);
    const src = opened.pages![0].source!;
    expect(src.protection?.scheme).toBe("hwpx-odf");
    expect(getSecret(src.protection!.secretId)).toBe(PW);
    expect(JSON.stringify(src)).not.toContain(PW);
    setPasswordAsker(async () => null);
    await expect(formatForExt("hwpx")!.open!({ name: "p.hwpx", path: null, bytes: enc }, { confirm: () => true })).rejects.toThrow("암호");
  });
});
