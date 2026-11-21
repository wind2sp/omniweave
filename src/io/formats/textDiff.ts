// Where two texts differ: paragraphs (whole strings) and letters, alike at both ends and matched in between by the
// longest common subsequence. Shared by the legacy writers (docWrite.ts, pptWrite.ts) — loaded with them, on a save.

/** Ranges of paragraphs that differ, [a0, a1) of `a` against [b0, b1) of `b`: alike at both ends and matched in between. */
export function changedRuns(a: readonly string[], b: readonly string[]): [number, number, number, number][] {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let q = 0;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > 4_000_000) return [[p, a.length - q, p, b.length - q]];
  // longest common subsequence of whole paragraphs; what lies between two matches is one run
  const w = B.length + 1;
  const L = new Uint32Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out: [number, number, number, number][] = [];
  let i = 0, j = 0, i0 = 0, j0 = 0;
  const close = () => {
    if (i > i0 || j > j0) out.push([p + i0, p + i, p + j0, p + j]);
  };
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      close();
      i++, j++;
      i0 = i;
      j0 = j;
    } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) i++;
    else j++;
  }
  i = A.length;
  j = B.length;
  close();
  return out;
}

/**
 * Where two texts differ, letter by letter: the ranges [a, b) of `a` replaced by `ins` (alike at both ends, then the
 * longest common subsequence of letters; a middle too long to compare is one range).
 */
export function letterChanges(x: string, y: string): { a: number; b: number; ins: string }[] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let q = 0;
  while (q < x.length - p && q < y.length - p && x[x.length - 1 - q] === y[y.length - 1 - q]) q++;
  const A = x.slice(p, x.length - q), B = y.slice(p, y.length - q);
  if (!A.length && !B.length) return [];
  if (!A.length || !B.length || A.length * B.length > 4_000_000) return [{ a: p, b: x.length - q, ins: B }];
  const w = B.length + 1;
  const L = new Uint16Array((A.length + 1) * w);
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out: { a: number; b: number; ins: string }[] = [];
  let cur: { a: number; b: number; ins: string } | null = null;
  let i = 0, j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) {
      if (cur) out.push(cur), (cur = null);
      i++, j++;
    } else if (j >= B.length || (i < A.length && L[(i + 1) * w + j] >= L[i * w + j + 1])) {
      cur ??= { a: p + i, b: p + i, ins: "" };
      cur.b = p + ++i;
    } else {
      cur ??= { a: p + i, b: p + i, ins: "" };
      cur.ins += B[j++];
    }
  }
  if (cur) out.push(cur);
  return out;
}

