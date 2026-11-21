// QA (start screen · updater · colour field): semver comparison for the update pill, recent-file privacy,
// and the colour well's value while a colour is "none".
import { describe, expect, it } from "vitest";
import { compareVersions } from "../src/ui/shell/semver";
import { recentThumbAllowed, rememberRecent, useRecent } from "../src/ui/shell/recent";
import { hexToCommit, pickerHex } from "../src/ui/shell/colorValue";
import { newDocument, newPage } from "../src/core/types";

describe("update pill: compareVersions follows semver", () => {
  it("numeric parts compare as numbers", () => {
    expect(compareVersions("0.2.10", "0.2.9")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
  it("a release is newer than its own pre-release (running 0.3.0-beta.1 must be offered 0.3.0)", () => {
    expect(compareVersions("0.3.0", "0.3.0-beta.1")).toBe(1);
    expect(compareVersions("0.3.0-beta.1", "0.3.0")).toBe(-1);
  });
  it("pre-release identifiers: numeric < alphanumeric, numbers numerically, more fields newer", () => {
    expect(compareVersions("1.0.0-beta.10", "1.0.0-beta.2")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0-beta.11")).toBe(1);
  });
  it("build metadata is ignored", () => {
    expect(compareVersions("1.0.0+build.5", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.1+x", "1.0.0+y")).toBe(1);
  });
});

describe("recent files: no clear-text thumbnail of a password-protected document", () => {
  it("a protected document gets no thumbnail", () => {
    const doc = newDocument();
    expect(recentThumbAllowed(doc, false)).toBe(true);
    expect(recentThumbAllowed(doc, true)).toBe(false);
    const p = newPage("DOCUMENT", 100, 100, "p");
    p.source = { format: "docx", name: "x.docx", protection: { scheme: "office-agile", secretId: "s1" } } as any;
    doc.pages = [p];
    expect(recentThumbAllowed(doc, false)).toBe(false);
  });
  it("rememberRecent keeps a path but no thumb when protected; browser names without a path are skipped", () => {
    useRecent.setState({ list: [] });
    rememberRecent("C:\\docs\\secret.omw", "secret.omw", newDocument(), { protected: true });
    rememberRecent("plain.omw", "plain.omw", newDocument());
    const list = useRecent.getState().list;
    expect(list.map((x) => x.path)).toEqual(["C:\\docs\\secret.omw"]);
    expect(list[0].thumb).toBeNull();
  });
});

describe("colour well while the colour is none", () => {
  it("the picker starts at the remembered colour, so picking black still changes something", () => {
    expect(pickerHex("#ABCDEF", "#111111")).toBe("#abcdef");
    expect(pickerHex(null, "#1d1f24")).toBe("#1d1f24");
    expect(pickerHex(null, undefined)).not.toBe("#000000");
  });
  it("typing the hex of the shown colour into a none field still sets it", () => {
    expect(hexToCommit("000000", null)).toBe("#000000");
    expect(hexToCommit("#000000", "#000000")).toBeNull();
    expect(hexToCommit("fff", "#000000")).toBe("#ffffff");
    expect(hexToCommit("zz", null)).toBeNull();
  });
});
