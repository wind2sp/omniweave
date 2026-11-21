// Release tooling: the public-tree export rules and check (scripts/make-public-tree.mjs) and the Store package
// helpers (scripts/make-msix.mjs).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ES module without types
import { checkText, needsPrivateQa, patternRegExp, plan, readExcludes, stripComments } from "../scripts/make-public-tree.mjs";
// @ts-expect-error plain ES module without types
import { identity, manifest, packageVersion, resw, STRINGS } from "../scripts/make-msix.mjs";

describe("public tree", () => {
  it("patterns: folders, globs, exact files", () => {
    expect(patternRegExp("qa/").test("qa/interop/a.pdf")).toBe(true);
    expect(patternRegExp("qa/").test("qa")).toBe(true);
    expect(patternRegExp("qa/").test("qaPrivacy.ts")).toBe(false);
    expect(patternRegExp("docs/*.md").test("docs/a.md")).toBe(true);
    expect(patternRegExp("docs/*.md").test("docs/x/a.md")).toBe(false);
    expect(patternRegExp("docs/**").test("docs/x/a.md")).toBe(true);
  });

  it("leaves out the QA material, internal documents and comparison memos; keeps the technical design notes", () => {
    const files = ["qa/interop/a.docx", "docs/qa/ISSUES.md", "docs/WORK_BOARD.md", "docs/design/SHELL_LAYOUT.md", "docs/design/OCR.md", "src/main.tsx", "tests/core.test.ts", "scripts/release-dropbox.mjs", "docs/RELEASING.md"];
    const p = plan(files, readExcludes());
    expect(p.copy.sort()).toEqual(["docs/RELEASING.md", "docs/design/OCR.md", "src/main.tsx", "tests/core.test.ts"]);
  });

  it("finds tests that read qa/ in code, not in comments, and tests importing them", () => {
    const src: Record<string, string> = {
      "tests/a.test.ts": `// reads qa/interop in a comment only\nimport { x } from "../src/x";`,
      "tests/b.test.ts": `const f = readFileSync("qa/interop/x.docx");`,
      "tests/helper.ts": `export const DIR = join(ROOT, "qa", "samples");`,
      "tests/c.test.ts": `import { DIR } from "./helper";`,
      "tests/d.test.ts": `const u = "http://example.com"; // not a comment start inside a string`,
    };
    const got = needsPrivateQa(Object.keys(src), (f: string) => src[f]).sort();
    expect(got).toEqual(["tests/b.test.ts", "tests/c.test.ts", "tests/helper.ts"]);
    expect(stripComments(`a // b\n/* c */ d`)).not.toMatch(/[bc]/);
  });

  it("the check names the kind of finding, never the value", () => {
    const hits = checkText("docs/x.md", ["see C:\\Users\\someone\\x", "E:/omw-migrate/y", "mail a.person@example.org ok", "mail real.name@company.co.kr", "img@2x.png", "PC windsp did it", "NINEROW partners"].join("\n"), []);
    expect(hits.join("\n")).not.toMatch(/someone|real\.name/);
    expect(hits).toEqual(["docs/x.md:4 e-mail address"]); // patterns off here: only the address check
    const all = checkText("docs/x.md", ["see C:\\Users\\someone\\x", "E:/omw-migrate/y", "PC windsp did it", "NINEROW partners", "Ninerow Partners"].join("\n"));
    expect(all).toEqual(["docs/x.md:1 user-profile path", "docs/x.md:2 internal work folder", "docs/x.md:3 development PC name"]);
  });
});

describe("Store package", () => {
  it("version X.Y.Z → X.Y.Z.0", () => {
    expect(packageVersion("0.2.0")).toBe("0.2.0.0");
    expect(packageVersion("1.10.3-beta.2")).toBe("1.10.3.0");
  });

  it("identity: the Partner Center values in store_identity.json", () => {
    const id = identity("packaging/msix/store_identity.json");
    expect(id).toMatchObject({ Name: "NinerowPartners.Omniweave", PublisherDisplayName: "Ninerow Partners", placeholder: false });
    expect(id.Publisher).toMatch(/^CN=/);
  });

  it("manifest: every placeholder filled, escaped; runFullTrust, 19041, file types", () => {
    const tpl = readFileSync("packaging/msix/AppxManifest.template.xml", "utf8");
    const m = manifest(tpl, { Name: "A.B", Publisher: 'CN=X "Y"', PublisherDisplayName: "P & Q" }, "0.2.0.0");
    expect(m).not.toMatch(/\$[A-Z_]{3,}/);
    expect(m).toContain('Publisher="CN=X &quot;Y&quot;"');
    expect(m).toContain("P &amp; Q");
    expect(m).toContain('MinVersion="10.0.19041.0"');
    expect(m).toContain('<rescap:Capability Name="runFullTrust" />');
    for (const ext of [".omw", ".docx", ".hwpx", ".pptx", ".xlsx", ".pdf", ".psd", ".ai", ".dxf", ".dwg"]) expect(m).toContain(`>${ext}</uap:FileType>`);
  });

  it("names in four languages, no other company's product names", () => {
    expect(Object.keys(STRINGS)).toEqual(["ko-KR", "en-US", "ja-JP", "zh-CN"]);
    for (const s of Object.values(STRINGS) as Record<string, string>[]) {
      expect(s.AppDisplayName).toBe("Omniweave");
      expect(JSON.stringify(s)).not.toMatch(/Word|Excel|PowerPoint|Photoshop|Illustrator|Acrobat|AutoCAD|한글과컴퓨터/);
    }
    expect(resw({ A: "x<y" })).toContain("<value>x&lt;y</value>");
  });
});
