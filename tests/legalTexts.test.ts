// The license, notices and trademark texts are built into the app (About dialog), so the installer and the Store
// package carry them — docs/legal/IP_CHECKLIST.md 4.1 #5.
import { describe, expect, it } from "vitest";
import { LEGAL_TEXTS } from "../src/ui/shell/legalTexts";

describe("legal texts built into the app", () => {
  it("carries the full GPL v3, NOTICE + third-party notices and the trademark policy", () => {
    expect(LEGAL_TEXTS.license).toContain("GNU GENERAL PUBLIC LICENSE");
    expect(LEGAL_TEXTS.license).toContain("TERMS AND CONDITIONS");
    expect(LEGAL_TEXTS.license.length).toBeGreaterThan(30000);
    expect(LEGAL_TEXTS.notices).toContain("SPDX-License-Identifier: GPL-3.0-or-later");
    expect(LEGAL_TEXTS.notices).toContain("# Third-party notices");
    for (const s of ["Real-ESRGAN", "U²-Netp", "PP-OCRv5", "FOGRA39", "Pretendard", "pdf.js"]) expect(LEGAL_TEXTS.notices).toContain(s);
    for (const s of ["Microsoft Corporation", "Adobe Inc.", "Hancom", "Autodesk, Inc."]) expect(LEGAL_TEXTS.trademarks).toContain(s);
  });
});
