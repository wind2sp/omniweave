// Semantic-version comparison for the update pill (semver.org §11): build metadata ignored, a release is newer
// than its own pre-releases, pre-release identifiers compare field by field (numbers numerically, numeric <
// alphanumeric, more fields newer).

function parse(v: string): { core: number[]; pre: string[] } {
  const s = v.trim().replace(/^v/i, "").split("+")[0];
  const dash = s.indexOf("-");
  const core = (dash < 0 ? s : s.slice(0, dash)).split(".").map((x) => Number(x) || 0);
  const pre = dash < 0 ? [] : s.slice(dash + 1).split(".");
  return { core, pre };
}

const isNum = (x: string) => /^\d+$/.test(x);

/** -1 / 0 / 1 */
export function compareVersions(a: string, b: string): number {
  const A = parse(a), B = parse(b);
  for (let i = 0; i < Math.max(A.core.length, B.core.length); i++) {
    const c = Math.sign((A.core[i] ?? 0) - (B.core[i] ?? 0));
    if (c) return c;
  }
  if (!A.pre.length || !B.pre.length) return A.pre.length === B.pre.length ? 0 : A.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i], y = B.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (isNum(x) && isNum(y)) return Math.sign(Number(x) - Number(y));
    if (isNum(x)) return -1;
    if (isNum(y)) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
