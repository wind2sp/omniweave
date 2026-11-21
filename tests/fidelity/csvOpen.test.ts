// CSV ① 열기 충실도 (뷰어 목표 ①, 측정 공백 9번): Omniweave가 연 칸 값을 Excel이 같은 CSV를 열었을 때의 칸 값과 비교하고,
// 무편집 저장 바이트 동일·한 칸 편집 뒤 나머지 줄 보존을 잰다. 정답은 qa/interop/scripts/csv_make.ps1이 Excel로 만든
// <파일>.excel.json(저장소 자료: qa/interop/csv/, corpus: 로컬 폴더). Run by scripts/fidelity-csv.mjs
// (OMNIWEAVE_CSV_MEASURE=<out dir>); skipped in the normal `npm test`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";
import { useStore } from "../../src/core/store";
import { newDocument, type SceneNode } from "../../src/core/types";
import { sameTypeExport } from "../../src/io/formats";
import { collectTables } from "../../src/io/formats/csv";
import { readingOrder } from "../../src/io/formats/flow";
import { importFile, lastImport } from "../../src/ui/actions";
import { installDom } from "../coverage/helpers";
import { csvEditCheck } from "../../scripts/fidelity-verdict.mjs";
import * as C from "./compare";

const OUT = process.env.OMNIWEAVE_CSV_MEASURE;
const ROOT = process.cwd();
const S = () => useStore.getState();
const MARK = "~";

interface XCell {
  v: number | string | boolean | null;
  t: string;
  f: string;
}
interface Truth {
  encoding: string;
  delimiter: string;
  read: XCell[][];
  doubleClick: XCell[][];
}

/** a cell value Excel shows, compared with the text Omniweave shows: "same" (shown text), "value" (same value), else a class */
export function judge(omni0: string, x: XCell | undefined): { shown: boolean; value: boolean; why?: string } {
  // a line break inside a cell is one break whether the file wrote CR LF or LF (Excel keeps the file's; both show one)
  const nl = (s: string) => s.replace(/\r\n?/g, "\n");
  const omni = nl(omni0);
  const v = typeof x?.v === "string" ? nl(x.v) : x?.v ?? null, t = nl(x?.t ?? "");
  const shown = omni === t;
  let value: boolean;
  if (v === null) value = omni === "";
  else if (typeof v === "boolean") value = omni.trim().toUpperCase() === (v ? "TRUE" : "FALSE");
  else if (typeof v === "number") {
    const s = omni.trim().replace(/,/g, "");
    const pct = s.endsWith("%");
    const n = Number(pct ? s.slice(0, -1) : s) / (pct ? 100 : 1);
    value = s !== "" && Number.isFinite(n) && Math.abs(n - v) <= 1e-9 * Math.max(1, Math.abs(v));
  } else value = omni === v;
  if (shown) return { shown, value };
  const raw = omni.trim();
  const why =
    /^0\d+$/.test(raw) && typeof v === "number" ? "앞자리 0(Excel은 숫자로 바꿈)"
    : /^\d{16,}$/.test(raw) ? "긴 숫자(Excel은 15자리로 자름)"
    : /^=/.test(raw) ? "수식처럼 보이는 글(Excel은 계산)"
    : typeof v === "number" && /[ymdhs]/i.test(x!.f.replace(/"[^"]*"|\[[^\]]*\]/g, "")) ? "날짜·시각(Excel은 날짜 값으로 바꿈)"
    : typeof v === "number" && /e/i.test(raw) ? "지수 표기"
    : /\r|\n/.test(raw) || /\r|\n/.test(String(v)) ? "줄바꿈 든 칸"
    : String(v).trim() === raw ? "앞뒤 공백"
    : "기타";
  return { shown, value, why };
}

function inputs(): { set: "repo" | "public" | "corpus"; id: string; path: string; truth: string | null }[] {
  const out: { set: "repo" | "public" | "corpus"; id: string; path: string; truth: string | null }[] = [];
  for (const dir of ["qa/interop/csv", "qa/interop/omniweave-made"]) {
    const d = join(ROOT, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).sort())
      if (/\.csv$/i.test(f)) {
        const t = join(d, f.replace(/\.csv$/i, ".excel.json"));
        out.push({ set: "repo", id: `${dir}/${f}`, path: join(d, f), truth: existsSync(t) ? t : null });
      }
  }
  // corpus: the driver lists the files (in order) and where Excel's answers are (local folder, by number)
  const list = process.env.OMNIWEAVE_CSV_CORPUS ? (JSON.parse(readFileSync(process.env.OMNIWEAVE_CSV_CORPUS, "utf8")) as { path: string; truth: string | null }[]) : [];
  list.forEach((c, i) => out.push({ set: "corpus", id: `corpus#${i + 1}`, path: c.path, truth: c.truth && existsSync(c.truth) ? c.truth : null }));
  return out;
}

async function open(name: string, bytes: Uint8Array) {
  S().load(newDocument());
  await importFile({ name, path: null, bytes });
  return lastImport;
}
const save = async () => {
  const page = S().doc.pages.find((p) => p.source) ?? S().doc.pages[0];
  const out = await sameTypeExport(page)!.run(S().doc, page, { confirm: () => true });
  return typeof out === "string" ? new TextEncoder().encode(out) : out;
};
/** the grid as Omniweave shows it (tables split over pages joined, trailing empty rows/columns dropped) */
function omniGrid(): string[][] {
  const t = collectTables(S().doc.pages)[0];
  return trim(t ? t.rows.map((r) => r.map((c) => c.text)) : []);
}
/** differences the line comparison cannot see: line breaks inside quoted cells (compare.ts splits lines on CR LF / LF) */
function insideDiffs(a: Uint8Array, b: Uint8Array): string[] {
  const cr = (x: Uint8Array) => x.filter((c) => c === 13).length, lf = (x: Uint8Array) => x.filter((c) => c === 10).length;
  // (decodeText turns CR LF into LF, so cells cannot tell; the bytes can: same LF count, fewer CR = a CR LF inside a cell became LF)
  return lf(a) === lf(b) && cr(a) !== cr(b) ? [`칸 안 줄바꿈 CRLF→LF (CR ${cr(a)}→${cr(b)})`] : [];
}
function trim<T>(g: T[][], empty: (c: T) => boolean = (c) => (c as unknown as string) === ""): T[][] {
  const rows = g.map((r) => {
    const x = [...r];
    while (x.length && empty(x[x.length - 1])) x.pop();
    return x;
  });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

describe.skipIf(!OUT)("CSV open fidelity vs Excel (scripts/fidelity-csv.mjs)", () => {
  it("compares every cell with Excel's, unchanged save, one-cell edit", { timeout: 600_000 }, async () => {
    installDom();
    (globalThis as any).alert = () => {};
    const rows: unknown[] = [];
    for (const inp of inputs()) {
      const bytes = new Uint8Array(readFileSync(inp.path));
      const name = inp.set === "corpus" ? `${inp.id.replace("#", "")}.csv` : inp.id.split("/").pop()!;
      const r = await open(name, bytes);
      if (!r || r.error) {
        rows.push({ set: inp.set, id: inp.id, error: `열기 실패: ${String(r?.error ?? "?").slice(0, 80)}` });
        continue;
      }
      const grid = omniGrid();
      const row: any = { set: inp.set, id: inp.id, rows: grid.length, cols: Math.max(0, ...grid.map((x) => x.length)) };
      // ① cells vs Excel
      if (inp.truth) {
        const truth = JSON.parse(readFileSync(inp.truth, "utf8").replace(/^﻿/, "")) as Truth;
        const x = trim(truth.read, (c) => c.v === null && c.t === "");
        row.excelRows = x.length;
        row.excelCols = Math.max(0, ...x.map((r) => r.length));
        let cells = 0, shown = 0, value = 0, same = 0;
        const why: Record<string, number> = {}, shownOnly: Record<string, number> = {};
        for (let i = 0; i < Math.max(x.length, grid.length); i++)
          for (let k = 0; k < Math.max(x[i]?.length ?? 0, grid[i]?.length ?? 0); k++) {
            cells++;
            const j = judge(grid[i]?.[k] ?? "", x[i]?.[k]);
            if (j.shown) shown++;
            if (j.value) value++;
            if (j.value || j.shown) same++;
            if (!j.value && !j.shown) why[j.why!] = (why[j.why!] ?? 0) + 1;
            else if (!j.shown) shownOnly[j.why!] = (shownOnly[j.why!] ?? 0) + 1;
          }
        row.cells = { total: cells, same, shown, value, why, shownOnly };
        // Excel opened by double-click (no help): cells it gets wrong itself (encoding, delimiter)
        const d = trim(truth.doubleClick, (c) => c.v === null && c.t === "");
        let dSame = 0, dTotal = 0;
        for (let i = 0; i < x.length; i++) for (let k = 0; k < x[i].length; k++) (dTotal++, d[i]?.[k]?.t === x[i][k].t && dSame++);
        row.doubleClick = { same: dSame, total: dTotal, rows: d.length };
        row.encoding = truth.encoding;
        row.delimiter = truth.delimiter;
      }
      // unchanged save
      try {
        const out = await save();
        row.unchanged = C.sameBytes(bytes, out) ? "바이트 동일" : "다름";
        if (row.unchanged === "다름") row.unchangedDiffs = [...C.compareTextBytes(bytes, out).diffs, ...insideDiffs(bytes, out)];
      } catch (e: any) {
        row.unchanged = "저장 실패";
        row.unchangedDiffs = [String(e?.message ?? e).slice(0, 100)];
      }
      // one cell edited (row 2, first column): only that line may change, by the mark
      await open(name, bytes);
      const t = readingOrder(S().doc.pages).find((n) => n.type === "TABLE");
      if (t && t.type === "TABLE" && t.rows[1]?.[0]) {
        S().commit("csv cell", (d) => {
          for (const p of d.pages) for (const n of p.nodes as SceneNode[]) if (n.id === t.id && n.type === "TABLE") n.rows[1][0].text += MARK;
        });
        try {
          const out = await save();
          const cmp = C.compareTextBytes(bytes, out);
          const ra = C.csvRows(bytes), rb = C.csvRows(out);
          // QA 2026-11-16: the mark must be in the edited cell (row 2, column 1) — before, a mark in any cell counted
          const { hit, other } = csvEditCheck(ra, rb, 1, 0, MARK);
          const diffs = [...cmp.diffs.filter((x) => !x.startsWith("줄 ")), ...insideDiffs(bytes, out)];
          if (other) diffs.push(`다른 칸 ${other}개 바뀜`);
          if (cmp.lineDiffs.length > 1) diffs.push(`편집 외 ${cmp.lineDiffs.length - 1}줄 바뀜`);
          row.edit = { status: !hit ? "편집 반영 안 됨" : diffs.length ? "훼손" : "보존", diffs };
        } catch (e: any) {
          row.edit = { status: "저장 실패", diffs: [String(e?.message ?? e).slice(0, 100)] };
        }
      } else row.edit = { status: "해당 없음", diffs: [] };
      rows.push(row);
    }
    mkdirSync(resolve(OUT!), { recursive: true });
    writeFileSync(join(resolve(OUT!), "csv-open.json"), JSON.stringify({ when: new Date().toISOString(), rows }, null, 1));
  });
});
