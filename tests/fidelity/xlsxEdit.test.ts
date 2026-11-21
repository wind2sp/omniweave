// Excel one-place edit (측정 공백 9번, DESKTOP_DONE 2): every XLSX of the repository's test files (qa/**, the public
// sample) and of the personal corpus is opened as sheet pages, edited in one cell three ways (text, number, formula —
// tests/fidelity/sheetEdit.ts) and saved; the saved file is compared with the original part by part, and written with
// a manifest for the Excel check (qa/interop/scripts/xlsx_edit_check.ps1). Run by scripts/fidelity-xlsx-edit.mjs
// (OMNIWEAVE_XLSX_EDIT=<out dir>); skipped in the normal `npm test`.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "vitest";
import { useStore } from "../../src/core/store";
import { newDocument } from "../../src/core/types";
import { decryptOffice, isEncryptedOffice } from "../../src/io/crypto/office";
import { sameTypeExport } from "../../src/io/formats";
import { importFile, lastImport } from "../../src/ui/actions";
import { installDom } from "../coverage/helpers";
import { publicSamples } from "./samples";
import { cellValue, measureSheetEdit, pickSheetEdits, type SheetEditCase } from "./sheetEdit";

const OUT = process.env.OMNIWEAVE_XLSX_EDIT;
const ROOT = process.cwd();
const S = () => useStore.getState();
const PASSWORD = process.env.FIDELITY_TEST_PASSWORD ?? "omw-test-1234";

interface In {
  set: "public" | "repo" | "corpus";
  id: string;
  bytes: Uint8Array;
  note?: string;
}

function walk(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.xlsx$|\.xlsm$/i.test(f)) out.push(p);
  }
}

async function inputs(): Promise<In[]> {
  const list: In[] = [];
  for (const s of await publicSamples()) if (/\.xlsx$/i.test(s.name)) list.push({ set: "public", id: s.name, bytes: s.bytes });
  const repo: string[] = [];
  walk(join(ROOT, "qa"), repo);
  for (const p of repo) list.push({ set: "repo", id: relative(ROOT, p).replace(/\\/g, "/"), bytes: new Uint8Array(readFileSync(p)) });
  const corpus: string[] = [];
  const cdir = process.env.FIDELITY_CORPUS ? resolve(process.env.FIDELITY_CORPUS) : join(ROOT, "test-corpus");
  walk(cdir, corpus);
  corpus.forEach((p, i) => list.push({ set: "corpus", id: `corpus#${i + 1}`, bytes: new Uint8Array(readFileSync(p)) }));
  return list;
}

async function open(name: string, bytes: Uint8Array) {
  S().load(newDocument());
  await importFile({ name, path: null, bytes });
  return lastImport;
}

const save = async () => {
  const page = S().doc.pages.find((p) => p.sheet)!;
  const out = await sameTypeExport(page)!.run(S().doc, page, { confirm: () => true });
  return typeof out === "string" ? new TextEncoder().encode(out) : out;
};

describe.skipIf(!OUT)("Excel one-place edit (scripts/fidelity-xlsx-edit.mjs)", () => {
  it("edits one cell of every workbook, saves, compares the packages", { timeout: 1_800_000 }, async () => {
    installDom();
    (globalThis as any).alert = () => {};
    const quiet = [console.error, console.warn];
    console.error = console.warn = () => {};
    const dir = resolve(OUT!);
    mkdirSync(join(dir, "files"), { recursive: true });
    const rows: unknown[] = [];
    const manifest: unknown[] = [];
    for (const inp of await inputs()) {
      let bytes = inp.bytes;
      if (isEncryptedOffice(bytes)) {
        try {
          bytes = await decryptOffice(bytes, PASSWORD);
          inp.note = "암호 파일(시험 암호로 풀어 측정)";
        } catch {
          rows.push({ set: inp.set, id: inp.id, error: "암호 파일(시험 암호로 풀지 못함)", edits: [] });
          continue;
        }
      }
      const safe = inp.id.replace(/[^\w.#-]+/g, "_");
      const name = inp.set === "corpus" ? `${safe}.xlsx` : inp.id.split("/").pop()!;
      const r = await open(name, bytes);
      if (!r || r.error) {
        rows.push({ set: inp.set, id: inp.id, error: `열기 실패: ${String(r?.error ?? "?").slice(0, 80)}`, edits: [] });
        continue;
      }
      if (!S().doc.pages.some((p) => p.sheet)) {
        rows.push({ set: inp.set, id: inp.id, error: "시트로 열리지 않음", edits: [] });
        continue;
      }
      // unchanged save: the original bytes?
      let unchanged = "저장 실패";
      try {
        const same = await save();
        unchanged = same.length === bytes.length && same.every((b, i) => b === bytes[i]) ? "바이트 동일" : "다름";
      } catch {}
      const cases = pickSheetEdits(S().doc);
      writeFileSync(join(dir, "files", `${safe}.orig.xlsx`), bytes);
      manifest.push({ file: join(dir, "files", `${safe}.orig.xlsx`), sheet: "", addr: "", kind: "orig", expect: null, deps: [] });
      const edits: unknown[] = [];
      for (const e of cases) {
        await open(name, bytes);
        let res;
        try {
          res = await measureSheetEdit(() => S().doc, bytes, e, save);
        } catch (err: any) {
          edits.push({ kind: e.kind, error: String(err?.message ?? err).split("\n")[0].slice(0, 120) });
          continue;
        }
        const file = join(dir, "files", `${safe}.${e.kind}.xlsx`);
        if (res.out) writeFileSync(file, res.out);
        // recalculated cells (not the edited one) with the values Omniweave saved: Excel must agree
        const deps = [...res.changed]
          .filter((k) => k !== `${e.sheet}!${e.addr}`)
          .slice(0, 40)
          .map((k) => {
            const [si, a] = k.split("!");
            const v = cellValue(S().doc, Number(si), a);
            return { sheet: S().doc.pages.filter((p) => p.sheet)[Number(si)]?.sheet?.name, addr: a, v: v ?? null };
          });
        if (res.out) manifest.push({ file, sheet: e.sheetName, addr: e.addr, kind: e.kind, expect: e.expect, deps });
        edits.push({ kind: e.kind, where: inp.set === "corpus" ? "-" : `${e.sheetName}!${e.addr}`, reflected: res.reflected, valueOk: res.valueOk, diffs: res.diffs, changed: res.changed.size, deps: deps.length, parts: res.pkg ? { same: res.pkg.sameParts, total: res.pkg.parts } : null, file: res.out ? file : null });
      }
      rows.push({ set: inp.set, id: inp.id, note: inp.note, sheets: S().doc.pages.filter((p) => p.sheet).length, unchanged, edits, cases: cases.map((c: SheetEditCase) => c.kind) });
    }
    console.error = quiet[0];
    console.warn = quiet[1];
    writeFileSync(join(dir, "xlsx-edit-node.json"), JSON.stringify({ when: new Date().toISOString(), rows }, null, 1));
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
  });
});
