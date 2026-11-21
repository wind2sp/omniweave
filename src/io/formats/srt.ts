// SubRip subtitles (.srt): cues become rows of a table (번호 · 시작 · 끝 · 자막) that is edited
// like any other table; saving renumbers the cues and validates the time codes.

import { t as tr } from "../../i18n";
import type { Page, TableCell } from "../../core/types";
import { collectTables, tablePages } from "./csv";
import { pagesFor, sourceOf } from "./flow";
import { baseName } from "./text";
import { decodeText, encodeText } from "./textcodec";

export interface Cue {
  start: number; // ms
  end: number; // ms
  text: string;
}

const TIME = /(\d{1,2}):(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/;

export function parseTime(s: string): number | null {
  const m = TIME.exec(s.trim());
  if (!m) return null;
  return ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + Number((m[4] ?? "0").padEnd(3, "0"));
}

export function formatTime(ms: number): string {
  ms = Math.max(0, Math.round(ms));
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const p = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

export function parseSrt(text: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n\s*\n/);
  for (const b of blocks) {
    const lines = b.split("\n").filter((l, i) => i > 0 || l.trim());
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, z] = lines[ti].split("-->");
    const start = parseTime(a), end = parseTime(z);
    if (start === null || end === null) continue;
    cues.push({ start, end, text: lines.slice(ti + 1).join("\n").replace(/\s+$/, "") });
  }
  return cues;
}

export function toSrt(cues: Cue[]): string {
  return cues.map((c, i) => `${i + 1}\n${formatTime(c.start)} --> ${formatTime(c.end)}\n${c.text}\n`).join("\n");
}

/** Column titles of the subtitle table (read back by position, so they follow the UI language). */
export const srtHeader = () => [tr("engine.srt.header.number"), tr("engine.srt.header.start"), tr("engine.srt.header.end"), tr("engine.srt.header.text")];

export function cuesToRows(cues: Cue[]): TableCell[][] {
  return [srtHeader().map((t) => ({ text: t })), ...cues.map((c, i) => [{ text: String(i + 1), align: "RIGHT" as const }, { text: formatTime(c.start) }, { text: formatTime(c.end) }, { text: c.text }])];
}

export function importSrt(bytes: Uint8Array, name: string): { pages: Page[]; cues: Cue[] } {
  const d = decodeText(bytes);
  const cues = parseSrt(d.text);
  if (!cues.length && d.text.trim()) throw new Error(tr("engine.srt.notSrt"));
  const pages = tablePages(cuesToRows(cues), baseName(name), { format: "srt", name, encoding: d.encoding, eol: d.eol, bom: d.bom }, tr("engine.srt.sheetName"), [52, 116, 116, 358]);
  return { pages, cues };
}

/** Cues from the subtitle table(s); rows with unreadable times are reported, not dropped silently. */
export function cuesFromPages(pages: Page[]): { cues: Cue[]; bad: number[] } {
  const t = collectTables(pagesFor(pages, ["srt"])).find((x) => x.rows[0]?.length >= 4) ?? collectTables(pagesFor(pages, ["srt"]))[0];
  if (!t) return { cues: [], bad: [] };
  const cues: Cue[] = [];
  const bad: number[] = [];
  const rows = t.headerRow ? t.rows.slice(1) : t.rows;
  rows.forEach((r, i) => {
    const start = parseTime(r[1]?.text ?? ""), end = parseTime(r[2]?.text ?? "");
    const text = r[3]?.text ?? "";
    if (start === null || end === null) {
      if ((r[1]?.text ?? "") + (r[2]?.text ?? "") + text) bad.push(i + 1);
      return;
    }
    cues.push({ start, end: Math.max(start, end), text });
  });
  return { cues, bad };
}

export function exportSrt(pages: Page[]): Uint8Array {
  const { cues, bad } = cuesFromPages(pages);
  if (bad.length) throw new Error(tr("engine.srt.badTimes", { rows: bad.slice(0, 10).join(", ") }));
  const src = sourceOf(pages, ["srt"]);
  return encodeText(toSrt(cues), { encoding: src?.encoding, bom: src?.bom, eol: src?.eol ?? "\r\n" });
}
