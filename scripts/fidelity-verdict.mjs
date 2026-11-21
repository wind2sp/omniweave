// Verdicts shared by the measurement scripts and their tests (tests/fidelity/measureVerdict.test.ts).
// QA 2026-11-16 (measure-gaps 검수): an edit is "보존" only when every checker that ran actually looked at it.

/**
 * Excel one-place edit (scripts/fidelity-xlsx-edit.mjs): kept = the edit is in the file, nothing else changed, and —
 * when the Excel check ran — Excel opened the file without repair and saw the edited value. A missing Excel result
 * (the check crashed or skipped the file) or a blind checker (the deliberately broken control files opened "ok") is
 * not a pass.
 * @param {{ error?: string, reflected?: boolean, diffs?: string[] }} e
 * @param {{ open: string, match?: boolean } | undefined} x
 * @param {{ ran: boolean, controlsCaught: boolean }} excel
 */
export function xlsxEditKept(e, x, excel) {
  if (e.error || !e.reflected || (e.diffs ?? []).length) return false;
  if (!excel.ran) return true;
  return excel.controlsCaught && !!x && x.open === "ok" && !!x.match;
}

/** every control file has an Excel result and none of them opened as "ok" */
export function excelControlsCaught(controls) {
  return controls.length > 0 && controls.every((c) => !!c && c.open !== "ok");
}

/**
 * CSV one-cell edit (tests/fidelity/csvOpen.test.ts): hit = the chosen cell holds its old text + mark;
 * other = every other cell that changed, disappeared or appeared.
 * @param {string[][]} ra rows before
 * @param {string[][]} rb rows after
 */
export function csvEditCheck(ra, rb, row, col, mark) {
  const hit = ra[row]?.[col] !== undefined && rb[row]?.[col] === ra[row][col] + mark;
  let other = 0;
  for (let i = 0; i < Math.max(ra.length, rb.length); i++)
    for (let k = 0; k < Math.max(ra[i]?.length ?? 0, rb[i]?.length ?? 0); k++) {
      if (i === row && k === col) continue;
      if (ra[i]?.[k] !== rb[i]?.[k]) other++;
    }
  return { hit, other };
}
