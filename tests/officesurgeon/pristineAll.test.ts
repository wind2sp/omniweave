// Original preservation: every HWPX / DOCX / PPTX / XLSX sample, opened and saved in its own format without a
// change, must come back byte for byte the file it was (the Office Surgeon's "unchanged" answer).
//
// Regression (0.1.8–0.1.11): a HWPX table the importer split across pages was cut into pieces that did not say they
// continue one another; once 한글's page rules reflowed the body two pieces could land on one page, the block map
// counted one item more than the file had, the import kept no map and an unchanged save was written anew.
//
// Inputs: the committed samples (qa/interop, qa/samples) and, when OMW_PRISTINE_CORPUS names a folder (the personal
// test-corpus), its office files too — reported by number only, never by name.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { newParagraph, type OmwDocument, type TableNode } from "../../src/core/types";
import { isEncryptedOffice } from "../../src/io/crypto/office";
import { formatForExt, sameTypeExport } from "../../src/io/formats";
import { collectFlow, type OfficeItem } from "../../src/io/office";
import { officePages } from "../../src/io/formats/flow";
import { installDom } from "../coverage/helpers";

const EXTS = /\.(hwpx|docx|pptx|xlsx)$/i;
/** files whose unchanged save is known to differ (none: add one only with the reason) */
const KNOWN: Record<string, string> = {};

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXTS.test(f)) out.push(p);
  }
  return out;
}

const committed = [...walk("qa/interop"), ...walk("qa/samples")].map((p) => ({ label: relative(".", p).replace(/\\/g, "/"), path: p }));
const corpusDir = process.env.OMW_PRISTINE_CORPUS;
const corpus = corpusDir ? walk(corpusDir).map((p, i) => ({ label: `corpus office #${i + 1}`, path: p })) : [];
/** corpus files already known to differ before this test (OMW_PRISTINE_ALLOW="3,5": their numbers above) */
for (const n of (process.env.OMW_PRISTINE_ALLOW ?? "").split(",").filter(Boolean)) KNOWN[`corpus office #${n.trim()}`] = "known (personal corpus)";

async function roundtrip(name: string, bytes: Uint8Array): Promise<string> {
  const ext = name.split(".").pop()!.toLowerCase();
  const r = await formatForExt(ext)!.open({ name, path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: (r as any).masters ?? [], assets: (r as any).assets ?? {} } as OmwDocument;
  const page = doc.pages.find((p) => p.source) ?? doc.pages[0];
  const def = sameTypeExport(page);
  if (!def) return "no same-format save";
  let out = await def.run(doc, page, { confirm: () => true });
  if (typeof out === "string") out = new TextEncoder().encode(out);
  if (out.length === bytes.length && out.every((b, i) => b === bytes[i])) return "";
  return `differs (${bytes.length} → ${out.length} bytes)${(ext === "docx" || ext === "hwpx") && !doc.pages[0].source?.office ? ", no block map" : ""}`;
}

describe("unchanged save = the original bytes", () => {
  it("every committed (and, with OMW_PRISTINE_CORPUS, personal) HWPX / DOCX / PPTX / XLSX", { timeout: 900_000 }, async () => {
    installDom();
    (globalThis as any).alert = () => {};
    const bad: string[] = [];
    let checked = 0;
    for (const f of [...committed, ...corpus]) {
      const bytes = new Uint8Array(readFileSync(f.path));
      if (isEncryptedOffice(bytes)) continue; // needs its password (the fidelity run covers these)
      const name = f.path.split(/[\\/]/).pop()!;
      let why: string;
      try {
        why = await roundtrip(name, bytes);
      } catch (e: any) {
        // a file that does not open here (an expected refusal) is not a preservation fault
        if (/암호|DRM|password/i.test(String(e?.message))) continue;
        why = `failed: ${String(e?.message ?? e).split("\n")[0].slice(0, 80)}`;
      }
      checked++;
      if (why && KNOWN[f.label] === undefined) bad.push(`${f.label}: ${why}`);
    }
    expect(checked).toBeGreaterThan(30);
    expect(bad).toEqual([]);
  });

  it("the pieces of an imported table split across pages say they continue it (one table even on one page)", () => {
    installDom();
    const rows = Array.from({ length: 120 }, (_, i) => [{ text: `r${i}` }, { text: "x" }]);
    const table: OfficeItem = { kind: "table", table: { rows, colWidths: [200, 200], headerRow: false, style: {}, paras: [] } };
    const items: OfficeItem[] = [{ kind: "p", p: newParagraph("a") }, table, { kind: "p", p: newParagraph("b") }];
    for (const layout of [undefined, { pageBreaks: [], sections: [], pageRules: "hwp" as const }]) {
      const pages = officePages(items, "t", layout);
      const pieces = pages.flatMap((p) => p.nodes.filter((n): n is TableNode => n.type === "TABLE"));
      expect(pieces.length).toBeGreaterThan(1);
      for (const n of pieces.slice(1)) expect(n.flowCont).toBe(pieces[0].id);
      expect(collectFlow(pages).map((it) => it.kind)).toEqual(["p", "table", "p"]);
      // the body flow may set two pieces on one page (한글's saved page starts): still the one table of the file
      const one = pages.map((p) => ({ ...p, nodes: [...p.nodes] }));
      const [i, j] = [one.findIndex((p) => p.nodes.includes(pieces[0])), one.findIndex((p) => p.nodes.includes(pieces[1]))];
      one[j].nodes = one[j].nodes.filter((n) => n !== pieces[1]);
      one[i].nodes.push({ ...pieces[1], transform: { ...pieces[1].transform, y: pieces[0].transform.y + 1 } });
      expect(collectFlow(one).filter((it) => it.kind === "table").length).toBe(1);
    }
  });
});
