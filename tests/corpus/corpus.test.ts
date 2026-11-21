// Real-world sample files in test-corpus/ (not in the repository — skipped when absent).
// Opens every file whose format works without a browser through the real importFile path and
// records metadata only (name, format, result, time, pages/nodes) in test-corpus/REPORT-node.json.
// File contents are never copied into tests or reports.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useStore } from "../../src/core/store";
import { newDocument } from "../../src/core/types";
import { importFile, lastImport } from "../../src/ui/actions";
import { installDom, installPdfWorker } from "../coverage/helpers";

const ROOT = join(process.cwd(), "test-corpus");
const files: string[] = [];
if (existsSync(ROOT))
  for (const dir of readdirSync(ROOT)) {
    const d = join(ROOT, dir);
    if (!statSync(d).isDirectory()) continue;
    for (const f of readdirSync(d)) if (statSync(join(d, f)).isFile()) files.push(join(dir, f));
  }

/** Decoding needs the WebView (canvas / <video>): verified in the browser run instead. */
const BROWSER_ONLY = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a"]);
/** Formats that are expected to be refused with an explanation. */
const EXPECTED_REFUSAL = new Set(["heic", "heif"]);
/** Refusals that depend on the file (password, DRM) rather than the format. */
const REFUSAL_REASON = /암호|DRM|배포용/;
/** Read-only text extraction — reported as partial by design. */
const TEXT_ONLY = new Set(["doc", "hwp", "ppt", "xls"]);

export interface CorpusRow {
  file: string;
  ext: string;
  sizeKB: number;
  env: "node" | "browser";
  status: "성공" | "부분" | "실패" | "안내(미지원)";
  ms: number;
  pages: number;
  nodes: number;
  detail: string;
}

describe.skipIf(!files.length)("test-corpus (real files, metadata-only report)", () => {
  const rows: CorpusRow[] = [];

  it("opens every Node-capable file through importFile", { timeout: 600_000 }, async () => {
    installDom();
    await installPdfWorker();
    (globalThis as any).alert = () => {};
    for (const rel of files) {
      const ext = rel.split(".").pop()!.toLowerCase();
      // <file>.ref.pdf = the original program's PDF beside a corpus file (qa/interop/scripts/corpus_ref_pdf.ps1), not a corpus file
      if (rel.toLowerCase().endsWith("readme.md") || /^REPORT/i.test(rel.split(/[\\/]/).pop()!) || /\.ref\.pdf$/i.test(rel)) continue;
      if (BROWSER_ONLY.has(ext)) continue;
      const bytes = new Uint8Array(readFileSync(join(ROOT, rel)));
      useStore.getState().load(newDocument());
      const t0 = performance.now();
      await importFile({ name: rel.split(/[\\/]/).pop()!, path: null, bytes });
      const ms = Math.round(performance.now() - t0);
      const r = lastImport!;
      let status: CorpusRow["status"];
      if (r.error) status = EXPECTED_REFUSAL.has(ext) || REFUSAL_REASON.test(r.error) ? "안내(미지원)" : "실패";
      else if (TEXT_ONLY.has(ext) || r.warnings.length) status = "부분";
      else status = "성공";
      // only our own messages (counts, reasons) — never document text
      const detail = r.error ? r.error.split("\n")[0].slice(0, 140) : r.warnings.map((w) => w.slice(0, 140)).join(" / ");
      rows.push({ file: rel.replace(/\\/g, "/"), ext, sizeKB: Math.round(bytes.length / 1024), env: "node", status, ms, pages: r.pages, nodes: r.nodes, detail });
    }
    writeFileSync(join(ROOT, "REPORT-node.json"), JSON.stringify(rows, null, 1));
    const unexpected = rows.filter((r) => r.status === "실패");
    expect(unexpected.map((r) => `${r.file}: ${r.detail}`)).toEqual([]);
  });
});
