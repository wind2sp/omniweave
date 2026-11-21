// Word-made reference (qa/interop/word-made/omni-word-paragraphs.docx, saved by Word 2021 with its PDF): a 3-level
// multi-level list, exact / at-least / multiple line spacing and character spacing come in as Word shows them, and
// survive an Omniweave DOCX export → reopen.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { paraText } from "../src/core/richtext";
import { exportDocx, parseDocx, parseDocxFlow, type OfficeImportReport } from "../src/io/office";
import { newPage, newText } from "../src/core/types";

const FILE = join(process.cwd(), "qa/interop/word-made/omni-word-paragraphs.docx");

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const summary = (ps: ReturnType<typeof parseDocx>) =>
  ps.map((p) => ({
    text: paraText(p).slice(0, 24),
    list: p.list ? p.list.level : null,
    lh: p.lineHeight ? `${p.lineHeight.mode} ${p.lineHeight.v.v}${p.lineHeight.v.u}` : null,
    ls: p.lineSpacing,
    sp: p.runs.find((r) => r.letterSpacing)?.letterSpacing ?? null,
  }));

describe.skipIf(!existsSync(FILE))("Word-made paragraphs reference", () => {
  it("imports the multi-level list markers, line height modes and character spacing", () => {
    const ps = parseDocx(new Uint8Array(readFileSync(FILE)));
    const s = summary(ps);
    if (process.env.OMW_PRINT) console.log(JSON.stringify(s, null, 1));
    const lists = s.filter((x) => x.list !== null);
    expect(new Set(lists.map((x) => x.list))).toEqual(new Set([0, 1, 2]));
    expect(s.some((x) => x.lh?.startsWith("exact 360twip"))).toBe(true); // exactly 18 pt
    expect(s.some((x) => x.lh?.startsWith("atLeast 240twip"))).toBe(true); // at least 12 pt
    expect(s.some((x) => x.sp !== null && x.sp > 0) && s.some((x) => x.sp !== null && x.sp < 0)).toBe(true);
    // export → reopen keeps the same markers, levels and line modes
    const pg = newPage("DOCUMENT", 794, 1123, "P");
    const t = newText("", 600);
    t.paragraphs = ps;
    const rep: OfficeImportReport = { notesDropped: 0 };
    parseDocxFlow(new Uint8Array(readFileSync(FILE)), rep);
    t.lists = rep.lists; // the list definitions travel with the text node (io/formats/flow.ts officePages)
    pg.nodes.push(t);
    const back = summary(parseDocx(exportDocx([pg])));
    expect(back.map((x) => [x.text, x.list, x.lh])).toEqual(s.map((x) => [x.text, x.list, x.lh]));
  });
});
